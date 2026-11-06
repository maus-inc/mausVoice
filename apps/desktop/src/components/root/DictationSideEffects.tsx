import { NativeRecordingLease } from "../../utils/native-recording-lease";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { loadManualStyleForCurrentApp } from "../../actions/app-target.actions";
import {
  dismissMicrophoneSafetyToast,
  dismissToast,
  runToast,
  showToast,
} from "../../actions/toast.actions";
import { getIntl } from "../../i18n/intl";
import { getBrowserRouter } from "../../router";
import {
  createTranscriptionSession,
  resolveTranscriptionSessionKind,
} from "../../sessions";
import { ContinuousLiveSession } from "../../sessions/continuous-live-session";
import { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AgentStrategy } from "../../strategies/agent.strategy";
import { BaseStrategy } from "../../strategies/base.strategy";
import { DictationStrategy } from "../../strategies/dictation.strategy";
import {
  attachSessionAudioIntake,
  claimRecordingStart,
  resolveStartAtNativeDispatch,
  type RecordingStartAttempt,
  configureStreamingInterims,
  takeRecordingSession,
  finishAbortedRecording,
  isRecordingStartCurrent,
  releaseOwnedAudioListener,
  startPreparedSession,
  abortFailedRecordingStart,
  stopNativeRecordingForAbort,
} from "./dictation-recording-intake";
import { hasOwnedTimer, scheduleOwnedTimer } from "./dictation-timers";
import { enterAssistantTypeMode } from "./dictation-assistant-transition";
import { useRecordingFinalization } from "./dictation-finalization.hooks";
import { useRecordingStop } from "./dictation-stop.hooks";
import { useRecordingActivation } from "./dictation-activation.hooks";
import { useDictationEnvironment } from "./dictation-environment.hooks";
import { watchRecordingSession } from "./dictation-session-retirement";
import { releaseRecordingResource } from "./dictation-cleanup";
import { monitorAbortRelease } from "./dictation-abort-safety";
import { useDictationInteraction } from "./dictation-interaction.hooks";
import type {
  HandleEmptyResultInput,
  PostTranscriptInput,
  RawStopResp,
} from "./dictation-finalization.types";
export type {
  HandleEmptyResultInput,
  PostTranscriptInput,
} from "./dictation-finalization.types";
import { useRecordingLimitTimers } from "./dictation-limit-timers.hooks";
import { TranscriptionSession } from "../../types/transcription-session.types";
import { playAlertSound, tryPlayAudioChime } from "../../utils/audio.utils";
import { getLogger } from "../../utils/log.utils";
import { createId } from "../../utils/id.utils";
import { sendPhaseWithoutWaiting } from "../../utils/phase-delivery.utils";
import {
  getCancelTranscriptPromptMessage,
  getTranscriptionAudioDisclosure,
} from "../../utils/transcription-privacy.utils";
import { getToneIdToUse } from "../../utils/tone.utils";
import { captureUserSession } from "../../utils/user-session.utils";
import { withTimeout } from "../../utils/timeout.utils";
import {
  getMyPreferredMicrophone,
  getMyPrimaryDictationLanguage,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { surfaceMainWindow } from "../../utils/window.utils";

type AbortMessage = {
  title?: string;
  body: unknown;
};

const resolveRecordingStrategy = (
  mode: RecordingMode,
  currentStrategy: BaseStrategy | null,
): BaseStrategy => {
  if (currentStrategy) return currentStrategy;
  return mode === "agent" ? new AgentStrategy() : new DictationStrategy();
};

const requestRecordingToast = (
  show: HandleEmptyResultInput["showToast"],
  options: {
    message: string;
    toastType: "info" | "error";
    duration?: number;
    microphoneSafetyOwner?: string;
  },
  isCurrent: () => boolean,
): void => {
  const report = () => {
    try {
      if (isCurrent())
        getLogger().warning("Could not display the recording toast");
    } catch {
      // Logging is optional and must not create another unhandled rejection.
    }
  };
  try {
    const pending = show({ ...options, isCurrent });
    if (pending) void pending.catch(report);
  } catch {
    report();
  }
};

const MICROPHONE_SAFETY_MESSAGE =
  "The microphone may still be in use. If its indicator stays on, quit the app.";

/**
 * Owner for the microphone safety toast. A failed ID must not skip the warning,
 * so the fallback is a stable literal rather than an exception.
 */
const safetyOwnerFor = (
  audio: HandleEmptyResultInput["audio"],
): string | undefined => {
  if (!audio.captureFailed) return undefined;
  try {
    return createId();
  } catch {
    return "partial-capture";
  }
};

/** Warn before a possibly stalled snapshot write, not after it. */
const warnPartialCapture = (
  input: HandleEmptyResultInput,
  safetyOwner: string | undefined,
  isCurrent: () => boolean,
): void => {
  try {
    requestRecordingToast(
      input.showToast,
      {
        message: input.formatMessage({
          defaultMessage: MICROPHONE_SAFETY_MESSAGE,
        }),
        toastType: "error",
        duration: 8_000,
        microphoneSafetyOwner: safetyOwner,
      },
      isCurrent,
    );
  } catch {
    getLogger().warning("Could not display the microphone safety toast");
  }
};

/**
 * Store the recording that produced no transcript. Returns whether a durable
 * history row actually references saved audio, which is the only thing that
 * makes the recovery promise in the later toast true.
 */
const storeFailedRecording = async (
  input: HandleEmptyResultInput,
  transcriptionWarnings: string[],
  isCurrent: () => boolean,
): Promise<boolean> => {
  const { audio, transcribeResult } = input;
  if (!input.strategy.shouldStoreTranscript() || !isCurrent()) return false;
  try {
    const stored = await input.storeTranscriptionFn({
      audio,
      rawTranscript: null,
      sanitizedTranscript: null,
      transcript: null,
      transcriptionMetadata: transcribeResult?.metadata ?? {},
      postProcessMetadata: {},
      warnings: transcriptionWarnings,
      remoteStatus: null,
      remoteDeviceId: null,
    });
    return Boolean(stored.transcription?.audio?.filePath);
  } catch {
    if (isCurrent()) {
      getLogger().error(
        "Failed to save the recording after transcription failure",
      );
    }
    return false;
  }
};

const failureMessage = (
  input: HandleEmptyResultInput,
  audioSaved: boolean,
): string => {
  const { formatMessage } = input;
  if (input.audio.captureFailed) {
    const saved = audioSaved
      ? formatMessage({
          defaultMessage:
            "The recording may be incomplete. A partial recording was saved.",
        })
      : formatMessage({
          defaultMessage:
            "The recording may be incomplete. The partial recording was not saved.",
        });
    return `${saved} ${formatMessage({ defaultMessage: MICROPHONE_SAFETY_MESSAGE })}`;
  }
  return audioSaved
    ? formatMessage({
        defaultMessage:
          "Transcription failed. Your recording is saved so you can retry.",
      })
    : formatMessage({
        defaultMessage: "Transcription failed. Your recording was not saved.",
      });
};

export const handleEmptyTranscriptionResult = async (
  input: HandleEmptyResultInput,
): Promise<{ handled: boolean }> => {
  const { audio, transcribeResult, showToast } = input;
  const isCurrent = input.isCurrent ?? (() => true);
  if (!isCurrent()) return { handled: false };
  const rawTranscript = transcribeResult?.rawTranscript;
  const transcriptionWarnings = transcribeResult?.warnings ?? [];
  if (rawTranscript) {
    return { handled: false };
  }
  if (transcriptionWarnings.length === 0) {
    return { handled: false };
  }

  getLogger().warning(
    `stopRecordingRaw: empty rawTranscript with ${transcriptionWarnings.length} warning(s)`,
  );
  // Do not wait for a potentially stalled snapshot write to warn that a driver
  // may still hold the microphone. The later toast reports whether it was saved.
  const safetyOwner = safetyOwnerFor(audio);
  if (audio.captureFailed) warnPartialCapture(input, safetyOwner, isCurrent);

  const audioSaved = await storeFailedRecording(
    input,
    transcriptionWarnings,
    isCurrent,
  );
  if (!isCurrent()) return { handled: true };

  // Never promise recovery until a durable history record actually references
  // saved audio. Privacy settings, agent mode and storage errors can all prevent it.
  try {
    if (isCurrent())
      requestRecordingToast(
        showToast,
        {
          message: failureMessage(input, audioSaved),
          toastType: "error",
          duration: 8_000,
          ...(safetyOwner ? { microphoneSafetyOwner: safetyOwner } : {}),
        },
        isCurrent,
      );
  } catch {
    if (isCurrent()) {
      getLogger().warning("Could not display the transcription failure toast");
    }
  }

  if (isCurrent()) input.refreshMember();
  return { handled: true };
};

/**
 * UI handoff happens only after the reviewed History row is durable. Neither a
 * native surface failure nor a client-side route failure may turn that durable
 * success into a retry that creates a duplicate transcription.
 */
export const surfacePersistedReviewInHistory = async (
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  if (!isCurrent()) return;
  try {
    await surfaceMainWindow();
  } catch (error) {
    if (isCurrent()) {
      getLogger().warning(
        `Could not surface the saved transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!isCurrent()) return;
  try {
    await getBrowserRouter().navigate("/dashboard/transcriptions");
  } catch (error) {
    if (isCurrent()) {
      getLogger().warning(
        `Could not navigate to the saved transcript: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

/** Both message descriptors must remain literal so FormatJS can extract them. */
export const formatReviewPersistenceFailure = (
  formatMessage: (descriptor: { defaultMessage: string }) => string,
  incognitoModeEnabled: boolean,
): string => {
  if (incognitoModeEnabled) {
    return formatMessage({
      defaultMessage: "History is unavailable in Incognito Mode.",
    });
  }
  return formatMessage({
    defaultMessage:
      "Could not confirm that the edited transcript was saved in History.",
  });
};

/** The provider session plus the live-streaming wrapper it needs, if any. */
const createSessionForPrefs = (
  prefs: ReturnType<typeof getTranscriptionPrefs>,
): { session: TranscriptionSession; providerName: string } => {
  const providerSession = createTranscriptionSession(prefs);
  const kind = resolveTranscriptionSessionKind({
    mode: prefs.mode,
    provider: prefs.mode === "api" ? prefs.provider : null,
  });
  const session =
    kind === "live-streaming"
      ? new ContinuousLiveSession(providerSession)
      : providerSession;
  return { session, providerName: providerSession.constructor.name };
};

/**
 * Refuse a start whose strategy cannot run, reporting the strategy's own
 * message. `false` means the caller must return without starting anything.
 */
const availabilityAllows = async (
  strategy: BaseStrategy,
  isRecordingSession: () => boolean,
  abortRecording: (message?: {
    title?: string;
    body: unknown;
  }) => Promise<void>,
): Promise<boolean> => {
  const validationError = strategy.validateAvailability();
  if (!isRecordingSession()) return false;
  if (!validationError) return true;
  await abortRecording({
    title: validationError.title,
    body: validationError.body,
  });
  return false;
};

type PrepareAutoStyle = (
  mode: RecordingMode,
  state: ReturnType<typeof getAppState>,
  attempt: number,
  isCurrentSession: () => boolean,
) => Promise<boolean>;

/**
 * Publish the start intent and confirm the strategy may run. `false` means the
 * caller must return without starting: ownership can move while the app-based
 * style loads.
 */
const commitStartIntent = async ({
  mode,
  language,
  state,
  attempt,
  isRecordingSession,
  strategy,
  abortRecording,
  prepareAutoStyle,
  recordingOperationRef,
}: {
  mode: RecordingMode;
  language: string;
  state: ReturnType<typeof getAppState>;
  attempt: number;
  isRecordingSession: () => boolean;
  strategy: BaseStrategy;
  abortRecording: (message?: AbortMessage) => Promise<void>;
  prepareAutoStyle: PrepareAutoStyle;
  recordingOperationRef: { current: number };
}): Promise<boolean> => {
  produceAppState((draft) => {
    draft.activeRecordingMode = mode;
    draft.dictationLanguageOverride = language;
  });
  if (!(await availabilityAllows(strategy, isRecordingSession, abortRecording)))
    return false;
  // Stop if another recording took ownership while the style loaded.
  if (!(await prepareAutoStyle(mode, state, attempt, isRecordingSession)))
    return false;
  return recordingOperationRef.current === attempt && isRecordingSession();
};

/**
 * Warn the user while a cancelled microphone's release is pending or
 * unconfirmed, and retry the cancellation while this abort still owns the
 * recording. A failed stop keeps its own guidance instead of a generic toast.
 */
const createAbortSafety = ({
  lease,
  abortOperationId,
  isStopping,
  ownsAbort,
  intl,
}: {
  lease: NativeRecordingLease;
  abortOperationId: number;
  isStopping: boolean;
  ownsAbort: () => boolean;
  intl: ReturnType<typeof useIntl>;
}): ReturnType<typeof monitorAbortRelease> => {
  const safetyOwner = `${lease.ownerId}:${lease.generation ?? "pending"}:abort:${abortOperationId}`;
  const showSafetyToast = (
    duration: number,
    isCurrent: () => boolean,
  ): void => {
    try {
      runToast(
        showToast({
          message: intl.formatMessage({
            defaultMessage:
              "The microphone may still be in use. If its indicator stays on, quit the app.",
          }),
          toastType: "error",
          microphoneSafetyOwner: safetyOwner,
          duration,
          isCurrent,
        }),
      );
    } catch {
      getLogger().warning("Could not display the microphone safety toast");
    }
  };
  const dismissSafetyToast = (): void => {
    try {
      runToast(dismissMicrophoneSafetyToast(safetyOwner));
    } catch {
      getLogger().warning("Could not dismiss the microphone safety toast");
    }
  };
  return monitorAbortRelease({
    isCurrent: ownsAbort,
    immediately: isStopping,
    retry: () => lease.cancel(),
    show: showSafetyToast,
    dismiss: dismissSafetyToast,
  });
};

/**
 * A start that fails after the user already stopped it is not the user's
 * problem: the stop owns the microphone, so the failure is only logged.
 */
const reportStartFailure = ({
  error,
  owner,
  activeSession,
  isRecordingSession,
  isStopping,
  currentOperation,
  handleStartFailure,
}: {
  error: unknown;
  owner: RecordingStartAttempt;
  activeSession: TranscriptionSession | null;
  isRecordingSession: () => boolean;
  isStopping: boolean;
  currentOperation: number;
  handleStartFailure: (
    error: unknown,
    session: TranscriptionSession | null,
    operation: number,
  ) => void;
}): void => {
  if (!isRecordingSession()) return;
  if (isStopping && currentOperation === owner.operation) {
    getLogger().warning("Provider startup failed while recording was stopping");
    return;
  }
  handleStartFailure(error, activeSession, owner.operation);
};

/**
 * Release a previous native owner and attach the intake listener for this
 * start. `null` means the start lost the race and its session was cleaned up.
 */
const attachStartIntake = async ({
  session,
  isCurrentStart,
  shouldForwardLive,
  nativeStartOwnerRef,
}: {
  session: TranscriptionSession;
  isCurrentStart: () => boolean;
  shouldForwardLive: () => boolean;
  nativeStartOwnerRef: { current: NativeRecordingLease | null };
}): Promise<{
  lease: NativeRecordingLease;
  intake: Awaited<ReturnType<typeof attachSessionAudioIntake>>;
} | null> => {
  if (nativeStartOwnerRef.current) {
    await stopNativeRecordingForAbort(nativeStartOwnerRef);
    if (!isCurrentStart()) {
      session.cleanup();
      return null;
    }
  }
  const lease = new NativeRecordingLease();
  nativeStartOwnerRef.current = lease;
  const intake = await attachSessionAudioIntake(
    session,
    isCurrentStart,
    shouldForwardLive,
    (droppedSamples) => {
      getLogger().warning(
        `[Dictation] Startup audio buffer overflowed; dropped ${droppedSamples} samples`,
      );
    },
    lease.ownerId,
    () => lease.generation,
  );
  return { lease, intake };
};

/**
 * Report an omitted fast-style tail only after the history owner is known: a
 * review may already own the row, while the stop-path write can return no row
 * even when the strategy intended to store one.
 */
const reportFastStyleTruncation = (
  input: PostTranscriptInput,
  postProcessMetadata: Record<string, unknown> | null | undefined,
  historySaved: boolean,
  isCurrent: () => boolean,
): void => {
  const droppedChars = postProcessMetadata?.fastStyleTruncatedChars;
  if (typeof droppedChars !== "number" || droppedChars <= 0) return;
  const message = historySaved
    ? getIntl().formatMessage(
        {
          defaultMessage:
            "Fast styling omitted the last {droppedChars} characters. The full transcript is in History.",
        },
        { droppedChars },
      )
    : getIntl().formatMessage(
        {
          defaultMessage:
            "The last {droppedChars} characters were omitted by fast styling. Saving this dictation in History could not be confirmed.",
        },
        { droppedChars },
      );
  if (!isCurrent()) return;
  requestRecordingToast(
    input.showToast,
    { message, toastType: "info", duration: 8_000 },
    isCurrent,
  );
};

export const postProcessFinalizedTranscript = async (
  input: PostTranscriptInput,
): Promise<RawStopResp> => {
  const { strategy } = input;
  let expired = false;
  const isCurrent = () => !expired && (input.isCurrent?.() ?? true);
  if (!isCurrent()) return { shouldContinue: false };
  if (input.isAgentMode) {
    sendPhaseWithoutWaiting(() => input.sendIdle(), "idle");
  }
  if (!isCurrent()) return { shouldContinue: false };
  getLogger().info("Post-processing transcript");
  const result = await withTimeout(
    strategy.handleTranscript({
      rawTranscript: input.rawTranscript,
      processedTranscript: input.transcribeResult.processedTranscript,
      serverPostProcessMetadata: input.transcribeResult.postProcessMetadata,
      toneId: input.toneId,
      a11yInfo: input.a11yInfo,
      currentApp: input.appTarget,
      loadingToken: null,
      audio: input.audio,
      transcriptionMetadata: input.transcribeResult.metadata,
      transcriptionWarnings: input.transcribeResult.warnings,
      persistReviewedTranscript: input.persistReviewedTranscript,
      trace: input.trace ?? null,
      isCurrent,
    }),
    input.handleTranscriptTimeoutMs,
    "Transcript post-processing",
    () => {
      expired = true;
    },
  );
  if (!isCurrent()) return { shouldContinue: false };
  const transcript = result.transcript;
  const sanitizedTranscript = result.sanitizedTranscript;
  const postProcessMetadata = result.postProcessMetadata;
  const postProcessWarnings = result.postProcessWarnings;
  getLogger().verbose(
    `Post-processing complete: transcript=${transcript ? `${transcript.length} chars` : "empty"}, warnings=${postProcessWarnings.length}`,
  );
  sendPhaseWithoutWaiting(() => input.sendIdle(), "idle");
  if (!isCurrent()) return { shouldContinue: false };
  // "stop-path" is the default: a strategy that never went through review
  // persisted nothing, so this is the only place the row gets written. A
  // review either confirmed a write or attempted one whose reply was lost.
  // Retrying an unconfirmed write with a new ID could duplicate the row.
  const willStore =
    strategy.shouldStoreTranscript() &&
    (result.historyOwner ?? "stop-path") === "stop-path";
  if (!isCurrent()) return { shouldContinue: false };
  let historySaved = result.historyOwner === "review";
  if (willStore) {
    getLogger().verbose("Storing transcription");
    const stored = await input.storeTranscriptionFn({
      audio: input.audio,
      rawTranscript: input.rawTranscript ?? null,
      sanitizedTranscript,
      transcript,
      transcriptionMetadata: input.transcribeResult.metadata,
      postProcessMetadata,
      warnings: [...input.transcribeResult.warnings, ...postProcessWarnings],
      remoteStatus: result.remoteStatus,
      remoteDeviceId: result.remoteDeviceId,
      trace: input.trace ?? null,
    });
    historySaved = stored.transcription !== null;
  }
  if (!isCurrent()) return { shouldContinue: false };
  input.refreshMember();
  if (!isCurrent()) return { shouldContinue: false };

  reportFastStyleTruncation(
    input,
    postProcessMetadata,
    historySaved,
    isCurrent,
  );
  return {
    shouldContinue: result.shouldContinue,
  };
};

export const DictationSideEffects = () => {
  const intl = useIntl();

  // The composer popout is a separate webview that loads the same SPA. Dictation
  // is owned by the main window only — in any other window the dictation
  // hotkeys, held-key style switching, and click-to-dictate pipeline must stay
  // inert so we never run two dictation sessions at once.
  const isMainWindow = getCurrentWindow().label === "main";

  const {
    strategyRef,
    sessionRef,
    audioChunkUnlistenRef,
    recordingOperationRef,
    recordingSessionRef,
    nativeStartOwnerRef,
    isStoppingRef,
    isPausedRef,
    pipelineTraceRef,
    utteranceTonesRef,
    systemVolumeDim,
    clearUtteranceToneSnapshots,
    clearRecordingState,
    recordingWarningTimerRef,
    recordingAutoStopTimerRef,
    providerWarningTimerRef,
    providerAutoStopTimerRef,
    cancelPromptTimerRef,
    clearUserRecordingTimers,
    clearProviderRecordingTimers,
    clearRecordingTimers,
    clearCancelPromptTimer,
    hasPendingReview,
    isDictationUnlocked,
    handlersRef,
    dictationController,
    agentController,
    additionalLanguageControllers,
    hardResetHotkeyState,
    sendPhaseToPill,
  } = useDictationEnvironment(isMainWindow);

  // Single owner for the shared audio_chunk subscription. Every terminal path
  // that ends a recording must call this, otherwise the Tauri listener outlives
  // the session it was created for and keeps forwarding into a stale closure.
  const releaseAudioIntake = useCallback((owned?: UnlistenFn | null) => {
    releaseOwnedAudioListener(audioChunkUnlistenRef, owned);
  }, []);

  const abortRecording = useCallback(
    async (message?: AbortMessage) => {
      const ownedAudioChunkUnlisten = audioChunkUnlistenRef.current;
      // Invalidate the operation token first, so an in-flight start tail cannot
      // act on a recording that is over, and end the dim, so a volume write
      // already in flight cannot apply after this returns.
      const abortOperationId = ++recordingOperationRef.current;
      recordingSessionRef.current = null;
      const ownedSession = takeRecordingSession({ sessionRef, strategyRef });
      const lease = nativeStartOwnerRef.current;
      const ownsAbort = () =>
        recordingOperationRef.current === abortOperationId;
      let reportUnconfirmed: () => void = () => undefined;
      let releaseUnconfirmed = false;
      const stopNative = stopNativeRecordingForAbort(
        nativeStartOwnerRef,
        () => {
          releaseUnconfirmed = true;
          reportUnconfirmed();
        },
      );
      const safety = lease
        ? createAbortSafety({
            lease,
            abortOperationId,
            isStopping: isStoppingRef.current,
            ownsAbort,
            intl,
          })
        : null;
      if (safety) {
        reportUnconfirmed = safety.failed;
        if (releaseUnconfirmed) safety.failed();
        safety.watch(stopNative);
      }
      const whileOwned = (action: () => void) => () => {
        if (ownsAbort()) action();
      };
      // Start retiring the old session before other cleanup can reenter and
      // install a successor. Strategy cleanup checks ownership before shared writes.
      const finishAbort = finishAbortedRecording(
        ownedSession,
        abortOperationId,
        () => recordingOperationRef.current,
        clearRecordingState,
      );
      finishAbort.catch(() => undefined);
      releaseRecordingResource(
        "Recording style",
        "during abort",
        whileOwned(clearUtteranceToneSnapshots),
      );
      releaseRecordingResource(
        "System volume",
        "during abort",
        whileOwned(() => systemVolumeDim.endRecording()),
      );
      releaseRecordingResource(
        "Recording timers",
        "during abort",
        whileOwned(clearRecordingTimers),
      );
      releaseRecordingResource(
        "Cancel timer",
        "during abort",
        whileOwned(clearCancelPromptTimer),
      );
      releaseRecordingResource(
        "Hotkeys",
        "during abort",
        whileOwned(hardResetHotkeyState),
      );
      releaseRecordingResource("Audio intake", "during abort", () =>
        releaseAudioIntake(ownedAudioChunkUnlisten),
      );
      if (ownsAbort()) sendPhaseWithoutWaiting(sendPhaseToPill, "idle");
      const abortReason = message
        ? `, reason=${String(message.body).slice(0, 120)}`
        : "";
      getLogger().info(
        `Aborting recording (hasSession=${!!ownedSession.session}, hasStrategy=${!!ownedSession.strategy}${abortReason})`,
      );
      await stopNative;
      await finishAbort;

      if (
        message &&
        !safety?.isFailed() &&
        recordingOperationRef.current === abortOperationId
      ) {
        playAlertSound();
        runToast(
          showToast({
            message: String(message.body),
            toastType: "error",
            duration: 8_000,
            isCurrent: ownsAbort,
          }),
        );
      }
    },
    [
      clearCancelPromptTimer,
      clearRecordingState,
      clearRecordingTimers,
      clearUtteranceToneSnapshots,
      hardResetHotkeyState,
      releaseAudioIntake,
      sendPhaseToPill,
      systemVolumeDim,
      intl,
    ],
  );

  useEffect(() => {
    if (!isMainWindow) return;
    return watchRecordingSession(
      (check) =>
        useAppStore.subscribe((state, previous) => {
          if (
            state.auth?.uid !== previous.auth?.uid ||
            state.authSessionNonce !== previous.authSessionNonce
          ) {
            check();
          }
        }),
      recordingSessionRef,
      () => abortRecording(),
    );
  }, [abortRecording, isMainWindow, recordingSessionRef]);

  const { captureStopRecordingInfo, finalizeAndPostProcess } =
    useRecordingFinalization({
      sessionRef,
      strategyRef,
      pipelineTraceRef,
      utteranceTonesRef,
      nativeStartOwnerRef,
      sendPhaseToPill,
      postProcessFinalizedTranscript,
      handleEmptyTranscriptionResult,
      surfacePersistedReviewInHistory,
      formatReviewPersistenceFailure,
    });

  const { isStopping, stopRecording } = useRecordingStop({
    audioChunkUnlistenRef,
    isStoppingRef,
    recordingOperationRef,
    recordingSessionRef,
    pipelineTraceRef,
    utteranceTonesRef,
    captureStopRecordingInfo,
    finalizeAndPostProcess,
    abortRecording,
    clearRecordingTimers,
    clearUtteranceToneSnapshots,
    hardResetHotkeyState,
    releaseAudioIntake,
    sendPhaseToPill,
    systemVolumeDim,
  });
  const isDictationInteractable =
    isDictationUnlocked && !isStopping && !hasPendingReview;

  const { startUserRecordingTimers, startProviderRecordingTimers } =
    useRecordingLimitTimers({
      recordingWarningTimerRef,
      recordingAutoStopTimerRef,
      providerWarningTimerRef,
      providerAutoStopTimerRef,
      clearUserRecordingTimers,
      clearProviderRecordingTimers,
      sessionRef,
      recordingOperationRef,
      stopRecording,
    });

  /**
   * Loads the app's manual style before the utterance is seeded, when the
   * preference allows it.
   *
   * Returns false when a newer start or an abort took over while the load was in
   * flight, which is the caller's signal to stop: continuing would seed a tone
   * snapshot for a recording that is no longer current.
   */
  const prepareAutoStyle = useCallback(
    async (
      mode: RecordingMode,
      state: ReturnType<typeof getAppState>,
      attempt: number,
      isCurrentSession: () => boolean,
    ): Promise<boolean> => {
      if (
        mode !== "dictate" ||
        state.onboarding.dictationOverrideEnabled ||
        state.local.disableAutoStyleLoading
      ) {
        return true;
      }
      await loadManualStyleForCurrentApp(
        () => recordingOperationRef.current === attempt && isCurrentSession(),
      );
      if (recordingOperationRef.current !== attempt || !isCurrentSession()) {
        getLogger().warning(
          "Recording start was aborted or replaced while loading the style",
        );
        return false;
      }
      return true;
    },
    [],
  );

  /** Unwind only the start that still owns the recording. */
  const handleStartFailure = useCallback(
    (
      error: unknown,
      activeSession: TranscriptionSession | null,
      operationId: number,
    ): void => {
      if (
        !abortFailedRecordingStart(
          error,
          activeSession,
          operationId,
          recordingOperationRef.current,
          abortRecording,
        )
      )
        return;

      runToast(
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording failed",
          }),
          toastType: "error",
          duration: 8_000,
        }),
      );
    },
    [abortRecording, intl],
  );

  const pendingStartRef = useRef<RecordingStartAttempt | null>(null);
  const beginRecording = useCallback(
    async (
      args: { mode: RecordingMode; language?: string | null },
      onStartDispatched: (operation: number) => void,
      onClaimed: (attempt: RecordingStartAttempt) => void,
    ) => {
      const state = getAppState();
      const owner = claimRecordingStart({
        operationRef: recordingOperationRef,
        pendingRef: pendingStartRef,
        isStopping: isStoppingRef.current,
        hasNativeLease: nativeStartOwnerRef.current !== null,
        currentMode: state.activeRecordingMode,
        requestedMode: args.mode,
      });
      if (!owner) return;
      const isRecordingSession = captureUserSession();
      recordingSessionRef.current = isRecordingSession;
      onClaimed(owner);
      let activeSession: TranscriptionSession | null = null;
      try {
        const attempt = owner.operation;
        const mode = args.mode;
        const language = args.language || getMyPrimaryDictationLanguage(state);
        const strategy = resolveRecordingStrategy(mode, strategyRef.current);
        if (
          !(await commitStartIntent({
            mode,
            language,
            state,
            attempt,
            isRecordingSession,
            strategy,
            abortRecording,
            prepareAutoStyle,
            recordingOperationRef,
          }))
        )
          return;

        // Seed the start snapshot after app-based style load. It is the
        // fallback style for the utterance; the snapshot taken at stop (which
        // includes any mid-dictation switch) is the authoritative one.
        utteranceTonesRef.current.seed(
          getToneIdToUse(getAppState(), {
            currentAppToneId: null,
          }),
        );

        const preferredMicrophone = getMyPreferredMicrophone(state);
        const transcriptPrefs = getTranscriptionPrefs(state);
        const operationId = ++recordingOperationRef.current;
        owner.operation = operationId;
        getLogger().info(`Transcription prefs: mode=${transcriptPrefs.mode}`);
        const { session, providerName } =
          createSessionForPrefs(transcriptPrefs);
        activeSession = session;
        getLogger().info(`Created transcription session: ${providerName}`);

        let audioForwardingReady = false;
        const isCurrentStart = () =>
          isRecordingSession() &&
          isRecordingStartCurrent(
            operationId,
            recordingOperationRef.current,
            session,
            sessionRef.current,
            strategy,
            strategyRef.current,
          );
        sessionRef.current = session;
        strategyRef.current = strategy;
        const attached = await attachStartIntake({
          session,
          isCurrentStart,
          shouldForwardLive: () => audioForwardingReady,
          nativeStartOwnerRef,
        });
        if (!attached) return;
        if (!attached.intake.current) {
          session.cleanup();
          return;
        }
        releaseOwnedAudioListener(audioChunkUnlistenRef);
        audioChunkUnlistenRef.current = attached.intake.unlisten;

        tryPlayAudioChime("start_recording_clip");
        configureStreamingInterims(
          session,
          strategy,
          operationId,
          () => recordingOperationRef.current,
          isRecordingSession,
        );

        const started = await startPreparedSession({
          session,
          strategy,
          buffer: attached.intake.buffer,
          isCurrent: isCurrentStart,
          lease: attached.lease,
          preferredMicrophone,
          startProviderTimers: () => {
            if (!isStoppingRef.current) {
              startProviderRecordingTimers();
              startUserRecordingTimers();
            }
          },
          onNativeStartDispatched: () => onStartDispatched(operationId),
          beforeNativeCapture: () => {
            isPausedRef.current = false;
          },
          markReady: () => {
            audioForwardingReady = true;
          },
        });
        if (!started || !isCurrentStart() || isStoppingRef.current) return;

        // Fire-and-forget. `startRecording` is an onActivate handler and the
        // activation controller serialises activate before deactivate, so
        // awaiting here would put the volume round trips in front of the stop
        // that the user's key release triggers, keeping the microphone open past
        // release. The dim retires itself on its own operation id, and every stop
        // path ends it before awaiting anything, so a stop landing mid-dim is
        // handled without awaiting.
        void systemVolumeDim.dim(operationId);
        if (isCurrentStart()) return operationId;
      } catch (error) {
        reportStartFailure({
          error,
          owner,
          activeSession,
          isRecordingSession,
          isStopping: isStoppingRef.current,
          currentOperation: recordingOperationRef.current,
          handleStartFailure,
        });
      } finally {
        if (pendingStartRef.current === owner) pendingStartRef.current = null;
      }
    },
    [
      abortRecording,
      clearRecordingState,
      clearRecordingTimers,
      handleStartFailure,
      prepareAutoStyle,
      hardResetHotkeyState,
      intl,
      startProviderRecordingTimers,
      startUserRecordingTimers,
      systemVolumeDim,
    ],
  );

  const startRecording = useCallback(
    (args: {
      mode: RecordingMode;
      language?: string | null;
      onNativeStartDispatched?: (operation: number) => void;
      deactivation?: AbortSignal;
    }) => {
      const attempt: { current: RecordingStartAttempt | null } = {
        current: null,
      };
      return resolveStartAtNativeDispatch(
        (onStartDispatched) =>
          beginRecording(
            args,
            (operation) => {
              args.onNativeStartDispatched?.(operation);
              onStartDispatched(operation);
            },
            (owner) => {
              attempt.current = owner;
            },
          ),
        args.deactivation,
        () => {
          if (attempt.current?.operation !== recordingOperationRef.current)
            return;
          void abortRecording().catch((error: unknown) =>
            getLogger().warning(`Could not cancel recording startup: ${error}`),
          );
        },
      );
    },
    [beginRecording, abortRecording],
  );

  const {
    startDictationRecording,
    stopDictationRecording,
    startAgentRecording,
    stopAgentRecording,
  } = useRecordingActivation(startRecording, stopRecording);
  const promptCancelTranscription = useCallback(() => {
    if (hasOwnedTimer(cancelPromptTimerRef)) {
      clearCancelPromptTimer();
      runToast(dismissToast());
      void abortRecording();
      return;
    }

    const CANCEL_PROMPT_DURATION = 5_000;
    scheduleOwnedTimer(cancelPromptTimerRef, () => {}, CANCEL_PROMPT_DURATION);

    // Only a live-streaming provider already holds the audio at this point, so
    // only that case changes the wording. A batch provider uploads after
    // recording stops and local mode never leaves the machine, so both keep the
    // original prompt rather than claim something was sent.
    void showToast({
      message: getCancelTranscriptPromptMessage(
        getTranscriptionAudioDisclosure(getAppState()),
        intl,
      ),
      toastType: "info",
      action: "confirm_cancel_transcription",
      duration: CANCEL_PROMPT_DURATION,
    }).catch((error) => {
      getLogger().error(`Failed to show cancel transcription toast: ${error}`);
    });
  }, [intl]);

  const enterTypeMode = useCallback(() => {
    enterAssistantTypeMode({
      operationRef: recordingOperationRef,
      nativeStartOwnerRef,
      sessionRef,
      audioChunkUnlistenRef,
      endVolumeDim: systemVolumeDim.endRecording,
      clearTimers: clearRecordingTimers,
      resetHotkeys: hardResetHotkeyState,
      releaseAudioIntake,
      clearToneSnapshots: clearUtteranceToneSnapshots,
      sendIdle: () => sendPhaseToPill("idle"),
    });
  }, [
    clearRecordingTimers,
    hardResetHotkeyState,
    releaseAudioIntake,
    sendPhaseToPill,
    clearUtteranceToneSnapshots,
    systemVolumeDim,
    recordingOperationRef,
    nativeStartOwnerRef,
    sessionRef,
  ]);

  useDictationInteraction({
    isMainWindow,
    isDictationInteractable,
    isDictationUnlocked,
    handlersRef,
    dictationController,
    agentController,
    additionalLanguageControllers,
    startDictationRecording,
    stopDictationRecording,
    startAgentRecording,
    stopAgentRecording,
    startRecording,
    stopRecording,
    abortRecording,
    promptCancelTranscription,
    enterTypeMode,
    sessionRef,
    strategyRef,
    recordingOperationRef,
    isPausedRef,
    isStoppingRef,
    nativeStartOwnerRef,
    clearUserRecordingTimers,
    startUserRecordingTimers,
  });

  return null;
};
