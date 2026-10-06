import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppTarget } from "@maus-inc/types";
import { delayed } from "@maus-inc/utilities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  loadManualStyleForCurrentApp,
  saveManualStyleForApp,
  tryRegisterCurrentAppTarget,
} from "../../actions/app-target.actions";
import {
  createConversation,
  loadChatMessages,
  sendChatMessage,
} from "../../actions/chat.actions";
import { refreshMember } from "../../actions/member.actions";
import { dismissToast, runToast, showToast } from "../../actions/toast.actions";
import { getIntl } from "../../i18n/intl";
import { applyInDictationStyleSwitch } from "../../actions/tone.actions";
import {
  resolveToolPermission,
  setToolAlwaysAllow,
} from "../../actions/tool.actions";
import {
  storeTranscription,
  type StoreTranscriptionOutput,
} from "../../actions/transcribe.actions";
import { recordStreak } from "../../actions/user.actions";
import {
  useHotkeyFire,
  useHotkeyFireMany,
  useHotkeyHold,
  useHotkeyHoldMany,
} from "../../hooks/hotkey.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { getBrowserRouter } from "../../router";
import { createTranscriptionSession } from "../../sessions";
import { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AgentStrategy } from "../../strategies/agent.strategy";
import { BaseStrategy } from "../../strategies/base.strategy";
import { DictationStrategy } from "../../strategies/dictation.strategy";
import { TextFieldInfo } from "../../types/accessibility.types";
import type { ReviewedTranscriptPersistenceInput } from "../../types/strategy.types";
import {
  attachSessionAudioIntake,
  createCurrentSegmentGuard,
  forwardAudioChunk,
  isRecordingStartCurrent,
  releaseRecordingResources,
  stopNativeRecordingForAbort,
  stopOwnedNativeStart,
} from "./dictation-recording-intake";
import { createSystemVolumeDim } from "./dictation-volume-dim";
import type {
  OverlayPhase,
  OverlayResolvePermissionPayload,
} from "../../types/overlay.types";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../../types/transcription-session.types";
import {
  ActivationController,
  debouncedToggle,
} from "../../utils/activation.utils";
import {
  trackAgentStart,
  trackAppUsed,
  trackDictationStart,
} from "../../utils/analytics.utils";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { playAlertSound, tryPlayAudioChime } from "../../utils/audio.utils";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  getDictationRecordingTimerDurations,
  getEffectiveDictationLimitMinutes,
  getProviderRecordingTimerDurations,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import {
  createUtteranceToneSnapshots,
  getEffectiveToneIdAtFinalize,
  isActivationComboHeld,
  resolveInDictationArrowStyleSwitch,
  resolveNewlyPressedDictationArrow,
} from "../../utils/dictation-style.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { createId } from "../../utils/id.utils";
import {
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  getAdditionalLanguageEntries,
  getHotkeyCombosForAction,
  getSwitchToStyleEntries,
  OPEN_CHAT_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
} from "../../utils/keyboard.utils";
import { getLogger } from "../../utils/log.utils";
import {
  getCancelTranscriptPromptMessage,
  getTranscriptionAudioDisclosure,
} from "../../utils/transcription-privacy.utils";
import { sendPillStageText } from "../../utils/overlay.utils";
import {
  markPipeline,
  startPipelineTrace,
  type PipelineTrace,
} from "../../utils/pipeline-trace";
import { resolvePillBodyClickIntent } from "../../utils/pill-click.utils";
import { resolvePillWindowSize } from "../../utils/pill-window-size.utils";
import { invokeStopRecording } from "../../utils/recorded-audio.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
  getToneIdToUse,
} from "../../utils/tone.utils";
import { withTimeout } from "../../utils/timeout.utils";
import {
  getEffectivePillVisibility,
  getIsDictationUnlocked,
  getIsOnboarded,
  getMyPreferredMicrophone,
  getMyPrimaryDictationLanguage,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { isPersistenceAllowed } from "../../utils/incognito.utils";
import { hasDictationBacklog } from "../../utils/output-routing.utils";
import { surfaceMainWindow } from "../../utils/window.utils";
import { resetHotkeyFilter } from "../../utils/hotkey-filter.utils";

type StartRecordingResponse = {
  sampleRate: number;
};

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

type RawStopResp = {
  shouldContinue: boolean;
  abortMessage?: string;
};

export type HandleEmptyResultInput = {
  audio: StopRecordingResponse;
  transcribeResult: TranscriptionSessionResult | undefined;
  strategy: Pick<BaseStrategy, "shouldStoreTranscript">;
  formatMessage: (descriptor: { defaultMessage: string }) => string;
  showToast: (options: {
    message: string;
    toastType: "info" | "error";
    duration?: number;
  }) => Promise<void> | void;
  storeTranscriptionFn: typeof storeTranscription;
  refreshMember: () => void;
};

export const handleEmptyTranscriptionResult = async (
  input: HandleEmptyResultInput,
): Promise<{ handled: boolean }> => {
  const { audio, transcribeResult, strategy, formatMessage, showToast } = input;
  const rawTranscript = transcribeResult?.rawTranscript;
  const transcriptionWarnings = transcribeResult?.warnings ?? [];
  if (rawTranscript) {
    return { handled: false };
  }
  if (transcriptionWarnings.length === 0) {
    return { handled: false };
  }

  getLogger().warning(
    `stopRecordingRaw: empty rawTranscript with ${transcriptionWarnings.length} warning(s); preserving recording`,
  );
  await showToast({
    message: formatMessage({
      defaultMessage:
        "Transcription failed. Your recording is saved so you can retry.",
    }),
    toastType: "error",
    duration: 8_000,
  });

  if (strategy.shouldStoreTranscript()) {
    await input.storeTranscriptionFn({
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
  }

  input.refreshMember();
  return { handled: true };
};

/**
 * UI handoff happens only after the reviewed History row is durable. Neither a
 * native surface failure nor a client-side route failure may turn that durable
 * success into a retry that creates a duplicate transcription.
 */
export const surfacePersistedReviewInHistory = async (): Promise<void> => {
  try {
    await surfaceMainWindow();
  } catch (error) {
    getLogger().warning(
      `Could not surface the saved transcript: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await getBrowserRouter().navigate("/dashboard/transcriptions");
  } catch (error) {
    getLogger().warning(
      `Could not navigate to the saved transcript: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

type ReviewMessageFormatter = (descriptor: {
  defaultMessage: string;
}) => string;

/** Both message descriptors must remain literal so FormatJS can extract them. */
export const formatReviewPersistenceFailure = (
  formatMessage: ReviewMessageFormatter,
  incognitoModeEnabled: boolean,
): string => {
  if (incognitoModeEnabled) {
    return formatMessage({
      defaultMessage:
        "History is unavailable in Incognito Mode. Your edited transcript remains on the pill.",
    });
  }
  return formatMessage({
    defaultMessage:
      "Could not save the edited transcript. It remains on the pill so you can retry.",
  });
};

export type PhaseBookkeeper = {
  issue: () => number;
  markSent: (seq: number, phase: OverlayPhase) => void;
  getLastSent: () => OverlayPhase | null;
};

export const createPhaseBookkeeper = (): PhaseBookkeeper => {
  let issued = 0;
  let lastSent: OverlayPhase | null = null;
  return {
    issue: () => {
      issued += 1;
      return issued;
    },
    markSent: (seq, phase) => {
      if (seq === issued) {
        lastSent = phase;
      }
    },
    getLastSent: () => lastSent,
  };
};

export type PostTranscriptInput = {
  audio: StopRecordingResponse;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
  toneId: string | null;
  rawTranscript: string;
  transcribeResult: TranscriptionSessionResult;
  strategy: Pick<BaseStrategy, "handleTranscript" | "shouldStoreTranscript">;
  isAgentMode: boolean;
  handleTranscriptTimeoutMs: number;
  sendIdle: () => Promise<void>;
  storeTranscriptionFn: typeof storeTranscription;
  refreshMember: () => void;
  /** Informational surface for warnings the user has to know about mid-flow. */
  showToast: (options: {
    message: string;
    toastType: "info" | "error";
    duration?: number;
  }) => Promise<void> | void;
  /** Review-before-insert persistence hook; forwarded to the strategy. */
  persistReviewedTranscript?: (
    input: ReviewedTranscriptPersistenceInput,
  ) => Promise<boolean>;
  /**
   * Writes the History row concurrently with delivery; forwarded to the
   * strategy, which starts it the moment the transcript is final.
   */
  persistTranscriptNow?: (
    input: ReviewedTranscriptPersistenceInput,
  ) => Promise<StoreTranscriptionOutput>;
  /** Pipeline timing marks threaded through to History storage. */
  trace?: PipelineTrace | null;
};

export const postProcessFinalizedTranscript = async (
  input: PostTranscriptInput,
): Promise<RawStopResp> => {
  const { strategy } = input;
  if (input.isAgentMode) {
    await input.sendIdle();
  }
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
      persistTranscriptNow: input.persistTranscriptNow,
      trace: input.trace ?? null,
    }),
    input.handleTranscriptTimeoutMs,
    "Transcript post-processing",
  );
  const transcript = result.transcript;
  const sanitizedTranscript = result.sanitizedTranscript;
  const postProcessMetadata = result.postProcessMetadata;
  const postProcessWarnings = result.postProcessWarnings;
  getLogger().verbose(
    `Post-processing complete: transcript=${transcript ? `${transcript.length} chars` : "empty"}, warnings=${postProcessWarnings.length}`,
  );
  await input.sendIdle();
  // "stop-path" is the default: a strategy that never went through review
  // persisted nothing, so this is the only place the row gets written. A
  // review that reported an owner already wrote it, or is holding it on the
  // pill after a failure it told the user to retry from. Writing here in that
  // last case would contradict the toast and duplicate the row on the retry.
  // A "concurrent" owner already started the write during delivery; settling
  // its promise here keeps the session locked exactly as long as the serial
  // path would, without writing a second row.
  const owner = result.historyOwner ?? "stop-path";
  const willStore = strategy.shouldStoreTranscript() && owner === "stop-path";
  const persistedConcurrently =
    owner === "concurrent" && result.pendingPersistence !== undefined;
  if (persistedConcurrently && result.pendingPersistence) {
    getLogger().verbose("Awaiting concurrent history persistence");
    await result.pendingPersistence;
  } else if (willStore) {
    getLogger().verbose("Storing transcription");
    await input.storeTranscriptionFn({
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
  }
  input.refreshMember();

  // Fast styling caps its input, so a long dictation reaches the destination
  // with its ending unstyled. The warning was recorded on the row and nothing
  // else, so the user got incomplete text with no notice during dictation. It
  // is raised here rather than in the action because surfacing it is a UI
  // concern, and this is where both facts it depends on are known.
  const droppedChars = postProcessMetadata?.fastStyleTruncatedChars;
  if (typeof droppedChars === "number" && droppedChars > 0) {
    // The wording differs because the promise does. With the row stored, the
    // untruncated raw text is in History and the user can recover the ending;
    // in incognito nothing is stored at all, so promising History would be a lie.
    // Deliberately different wording from the warning recorded on the History row.
    // This project derives message ids from a content hash, so reusing that
    // sentence here is an id collision and the extractor refuses it. The two are
    // also different surfaces: that one is a stored record, this one is a live
    // notification, and a transient toast does not need to read like a log line.
    //
    // Two calls rather than one call with a conditional descriptor, because the
    // extractor needs `id` and `defaultMessage` as string literals in the
    // argument and cannot follow a ternary.
    //
    // `isPersistenceAllowed()` is part of the condition because the store call
    // suppresses itself under incognito and ephemeral sessions: without it the
    // stored-wording fired for a row that was never written.
    const message =
      (willStore || persistedConcurrently) && isPersistenceAllowed()
        ? getIntl().formatMessage(
            {
              defaultMessage:
                "Fast styling left the last {droppedChars} characters of that dictation unstyled. The unstyled ending is in History.",
            },
            { droppedChars },
          )
        : getIntl().formatMessage(
            {
              defaultMessage:
                "That dictation outran fast styling, so its last {droppedChars} characters were left unstyled, and incognito mode is on, so that ending was not saved.",
            },
            { droppedChars },
          );
    await input.showToast({
      message,
      toastType: "info",
      duration: 8_000,
    });
  }
  return {
    shouldContinue: result.shouldContinue,
  };
};

type StopContext = {
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
};

type FinalizedRecording = {
  audio: StopRecordingResponse;
  a11yInfo: TextFieldInfo | null;
  appTarget: AppTarget | null;
  toneId: string | null;
  rawTranscript: string;
  transcribeResult: TranscriptionSessionResult;
};

const FINALIZE_TIMEOUT_MS = 90_000;
const HANDLE_TRANSCRIPT_TIMEOUT_MS = 60_000;
// Review-before-insert can remain open for its 5-minute decision window on
// either the native pill or the composer fallback. Budget the wrapper above
// that plus slack: a wrapper smaller than the review window would reject
// mid-review, skip storeTranscription below, and silently drop the transcript
// from history while the review could still insert on Save.
const REVIEW_HANDLE_TRANSCRIPT_TIMEOUT_MS = 6 * 60_000;
const PHASE_HEARTBEAT_INTERVAL_MS = 5_000;
/** Dictation backlog poll interval: how often to check whether the user
 *  has focused an editable target so accumulated backlog can be drained. */
const BACKLOG_DRAIN_POLL_MS = 1_000;
const IN_DICTATION_STYLE_KEYS = ["LeftArrow", "RightArrow"];

/**
 * Resuming is started from event listeners that cannot await it, so a failure
 * that escapes its own error handling is written to the log instead of
 * becoming an unhandled rejection.
 */
const logResumeFailure = (resuming: Promise<void>): void => {
  resuming.catch((error: unknown) => {
    getLogger().error(`Failed to resume dictation: ${error}`);
  });
};

export const DictationSideEffects = () => {
  const intl = useIntl();

  // The composer popout is a separate webview that loads the same SPA. Dictation
  // is owned by the main window only — in any other window the dictation
  // hotkeys, held-key style switching, and click-to-dictate pipeline must stay
  // inert so we never run two dictation sessions at once.
  const isMainWindow = getCurrentWindow().label === "main";

  const strategyRef = useRef<BaseStrategy | null>(null);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const audioChunkUnlistenRef = useRef<UnlistenFn | null>(null);
  const recordingOperationRef = useRef(0);
  const nativeStartOwnerRef = useRef<number | null>(null);
  const preDictationVolumeRef = useRef<number | null>(null);
  const recordingWarningTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingAutoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const providerWarningTimerRef = useRef<NodeJS.Timeout | null>(null);
  const providerAutoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cancelPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isStoppingRef = useRef(false);
  const isPausedRef = useRef(false);
  const phaseBookkeeperRef = useRef(createPhaseBookkeeper());
  const pipelineTraceRef = useRef<PipelineTrace | null>(null);
  // Last phase actually sent to the pill; drives the idle-reconciliation
  // heartbeat and keeps duplicate idle writes out of the pipe.
  const lastPhaseSentRef = useRef<OverlayPhase | null>(null);
  const previousStyleSwitchKeysRef = useRef<string[]>([]);
  const utteranceTonesRef = useRef(createUtteranceToneSnapshots());
  const [isStopping, setIsStopping] = useState(false);
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);

  const isManualStyling = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );
  const isActiveSession = useAppStore(
    (state) => state.activeRecordingMode !== null,
  );
  const activeRecordingMode = useAppStore((state) => state.activeRecordingMode);
  const keysHeld = useAppStore((state) => state.keysHeld);
  const assistantInputMode = useAppStore((state) => state.assistantInputMode);
  const additionalLanguageEntries = useAppStore(getAdditionalLanguageEntries);
  const switchToStyleEntries = useAppStore(getSwitchToStyleEntries);
  const inDictationStyleSwitchingEnabled = useAppStore(
    (state) => state.userPrefs?.inDictationStyleSwitchingEnabled ?? false,
  );
  const dictateCombos = useAppStore((state) =>
    getHotkeyCombosForAction(state, DICTATE_HOTKEY),
  );
  const hasPendingReview = useAppStore(
    (state) => state.pendingPillReview !== null,
  );
  const isDictationUnlocked = useAppStore(getIsDictationUnlocked);
  const isDictationInteractable =
    isDictationUnlocked && !isStopping && !hasPendingReview;
  const pillVisibility = useAppStore((state) =>
    getEffectivePillVisibility(state.userPrefs?.dictationPillVisibility),
  );

  /**
   * A pill set to "hidden" stays off-screen even while recording, so a
   * hotkey-started dictation would have no visual feedback. Revealing it for
   * the session (without touching the persisted preference) means the first
   * shortcut use after hiding brings the pill back; it hides again when idle.
   * Resolves once the visibility change has been applied, so callers can
   * start recording only after the pill is on screen.
   */
  const revealPillForActivityIfHidden = useCallback(async () => {
    if (
      getEffectivePillVisibility(
        getAppState().userPrefs?.dictationPillVisibility,
      ) !== "hidden"
    ) {
      return;
    }
    try {
      await invoke("set_pill_visibility", { visibility: "while_active" });
    } catch (error) {
      getLogger().error(`Failed to reveal pill: ${error}`);
    }
  }, []);

  const dictationController = useMemo(
    () =>
      new ActivationController(
        async () => {
          await revealPillForActivityIfHidden();
          await startDictationRecording();
        },
        () => stopDictationRecording(),
        // Hold-to-talk: dictation records while the hotkey (Fn) is held and stops on release.
        true,
      ),
    [revealPillForActivityIfHidden],
  );

  const agentController = useMemo(
    () =>
      new ActivationController(
        async () => {
          await revealPillForActivityIfHidden();
          await startAgentRecording();
        },
        () => stopAgentRecording(),
      ),
    [revealPillForActivityIfHidden],
  );

  const additionalLanguageControllers = useMemo(
    () =>
      additionalLanguageEntries.map((entry) => ({
        actionName: entry.actionName,
        controller: new ActivationController(
          async () => {
            await revealPillForActivityIfHidden();
            await startRecording({
              mode: "dictate",
              language: entry.language,
            });
          },
          () => stopRecording(),
        ),
      })),
    [additionalLanguageEntries, revealPillForActivityIfHidden],
  );

  const systemVolumeDim = useMemo(
    () =>
      createSystemVolumeDim({
        preDimVolumeRef: preDictationVolumeRef,
        getDimLevel: () => getAppState().userPrefs?.dictationAudioDim ?? 1.0,
      }),
    [],
  );

  const clearUserRecordingTimers = useCallback(() => {
    if (recordingWarningTimerRef.current) {
      clearTimeout(recordingWarningTimerRef.current);
      recordingWarningTimerRef.current = null;
    }
    if (recordingAutoStopTimerRef.current) {
      clearTimeout(recordingAutoStopTimerRef.current);
      recordingAutoStopTimerRef.current = null;
    }
  }, []);

  const clearProviderRecordingTimers = useCallback(() => {
    if (providerWarningTimerRef.current) {
      clearTimeout(providerWarningTimerRef.current);
      providerWarningTimerRef.current = null;
    }
    if (providerAutoStopTimerRef.current) {
      clearTimeout(providerAutoStopTimerRef.current);
      providerAutoStopTimerRef.current = null;
    }
  }, []);

  const clearRecordingTimers = useCallback(() => {
    clearUserRecordingTimers();
    clearProviderRecordingTimers();
  }, [clearProviderRecordingTimers, clearUserRecordingTimers]);

  useEffect(() => () => clearRecordingTimers(), [clearRecordingTimers]);

  useEffect(() => {
    return () => {
      // Invalidate the operation token first so an in-flight start tail cannot
      // arm timers or dim the volume after teardown.
      recordingOperationRef.current += 1;
      systemVolumeDim.endRecording();
      releaseRecordingResources({
        audioChunkUnlistenRef,
        sessionRef,
        strategyRef,
      });
    };
  }, [systemVolumeDim]);

  const clearCancelPromptTimer = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearTimeout(cancelPromptTimerRef.current);
      cancelPromptTimerRef.current = null;
    }
  }, []);

  const clearUtteranceToneSnapshots = useCallback(() => {
    utteranceTonesRef.current.clear();
  }, []);

  const clearRecordingState = useCallback(() => {
    isPausedRef.current = false;
    produceAppState((draft) => {
      draft.activeRecordingMode = null;
      draft.dictationLanguageOverride = null;
      draft.assistantInputMode = "voice";
    });
  }, []);

  const hardResetHotkeyState = useCallback(() => {
    dictationController.forceReset();
    agentController.forceReset();
    for (const { controller } of additionalLanguageControllers) {
      controller.forceReset();
    }

    produceAppState((draft) => {
      draft.keysHeld = [];
    });

    invoke("reset_key_listener_state").catch((error) =>
      getLogger().verbose(`Failed to reset key listener state: ${error}`),
    );
    resetHotkeyFilter();
  }, [additionalLanguageControllers, agentController, dictationController]);

  /**
   * Sends a phase to the pill with one immediate retry, and records it for
   * the reconciliation heartbeat. A failed pipe write must not leave the
   * pill stuck on a stale phase.
   */
  const sendPhaseToPill = useCallback(async (phase: OverlayPhase) => {
    lastPhaseSentRef.current = phase;
    if (phase === "idle") sendPillStageText(null);
    const bookkeeper = phaseBookkeeperRef.current;
    const seq = bookkeeper.issue();
    try {
      await invoke<void>("set_phase", { phase });
      bookkeeper.markSent(seq, phase);
    } catch (error) {
      getLogger().warning(
        `Failed to send phase ${phase} to pill: ${error}; retrying once`,
      );
      try {
        await invoke<void>("set_phase", { phase });
        bookkeeper.markSent(seq, phase);
      } catch (retryError) {
        getLogger().error(
          `Failed to send phase ${phase} to pill on retry: ${retryError}`,
        );
      }
    }
  }, []);

  // Idle-reconciliation heartbeat: if nothing is recording and the pill was
  // not last told to idle, re-send idle so a dropped phase IPC self-heals.
  useEffect(() => {
    if (!isMainWindow) return;
    const interval = setInterval(() => {
      const state = getAppState();
      if (state.activeRecordingMode !== null) {
        return;
      }
      if (phaseBookkeeperRef.current.getLastSent() === "idle") {
        return;
      }
      void sendPhaseToPill("idle");
    }, PHASE_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [sendPhaseToPill]);

  // Dictation backlog drain poll: while a session is active and there is a
  // non-empty backlog, periodically probe whether the user has focused an
  // editable target.  When they have, drain the full backlog once.
  // This covers the case where the user clicks an input while not speaking
  // (no interim segment fires to trigger the drain).
  useEffect(() => {
    if (!isMainWindow || !isActiveSession) return;
    const interval = setInterval(() => {
      const strategy = strategyRef.current;
      if (!(strategy instanceof DictationStrategy)) return;
      if (!hasDictationBacklog()) return;
      strategy.checkAndDrainBacklog().catch((error: unknown) => {
        getLogger().warning(`Backlog drain poll failed: ${error}`);
      });
    }, BACKLOG_DRAIN_POLL_MS);
    return () => clearInterval(interval);
  }, [isMainWindow, isActiveSession]);

  // Single owner for the shared audio_chunk subscription. Every terminal path
  // that ends a recording must call this, otherwise the Tauri listener outlives
  // the session it was created for and keeps forwarding into a stale closure.
  const releaseAudioIntake = useCallback((owned?: UnlistenFn | null) => {
    if (owned === undefined) {
      audioChunkUnlistenRef.current?.();
      audioChunkUnlistenRef.current = null;
      return;
    }
    if (audioChunkUnlistenRef.current === owned) {
      owned?.();
      audioChunkUnlistenRef.current = null;
    }
  }, []);

  const abortRecording = useCallback(
    async (message?: AbortMessage) => {
      const ownedAudioChunkUnlisten = audioChunkUnlistenRef.current;
      // Invalidate the operation token first, so an in-flight start tail cannot
      // act on a recording that is over, and end the dim, so a volume write
      // already in flight cannot apply after this returns.
      recordingOperationRef.current += 1;
      systemVolumeDim.endRecording();
      getLogger().info(
        `Aborting recording (hasSession=${!!sessionRef.current}, hasStrategy=${!!strategyRef.current}${message ? `, reason=${String(message.body).slice(0, 120)}` : ""})`,
      );
      clearRecordingTimers();
      clearCancelPromptTimer();
      hardResetHotkeyState();
      releaseAudioIntake(ownedAudioChunkUnlisten);
      // Before the `sendPhaseToPill` await, and with no await of its own between
      // taking the claim and releasing the stream. See
      // `stopNativeRecordingForAbort` for the race that ordering closes: an abort
      // suspending on the pill let a rapid restart call `start_recording` against
      // a still-live stream, and neither the abort nor the superseded start then
      // stopped it, so the restart inherited the old capture.
      //
      // A second `stop_recording` can still arrive from the superseded start's own
      // cleanup. That is already tolerated: the invoke is caught and logged.
      const stopNative = stopNativeRecordingForAbort(nativeStartOwnerRef);
      await sendPhaseToPill("idle");
      await stopNative;

      // Deterministic cleanup: clear the refs first so no other path can
      // reach the session mid-cleanup, then guard each cleanup call.
      const session = sessionRef.current;
      const strategy = strategyRef.current;
      strategyRef.current = null;
      sessionRef.current = null;
      clearUtteranceToneSnapshots();

      try {
        session?.cleanup();
      } catch (error) {
        getLogger().warning(`Session cleanup failed during abort: ${error}`);
      }
      try {
        await strategy?.cleanup();
      } catch (error) {
        getLogger().warning(`Strategy cleanup failed during abort: ${error}`);
      }

      clearRecordingState();

      if (message) {
        playAlertSound();
        runToast(
          showToast({
            message: String(message.body),
            toastType: "error",
            duration: 8_000,
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

  const captureStopRecordingInfo = useCallback(async (): Promise<{
    audio: StopRecordingResponse | null;
    context: Promise<StopContext>;
  }> => {
    tryPlayAudioChime("stop_recording_clip");
    getLogger().verbose("Invoking stop_recording and fetching a11y info");
    // Focus/app lookups (accessibility tree walk, icon extraction, app
    // target upsert) only feed post-processing and history, so they resolve
    // alongside transcription instead of gating the audio handoff.
    const context = Promise.all([
      invoke<TextFieldInfo>("get_text_field_info").catch((error) => {
        getLogger().verbose(`Failed to get text field info: ${error}`);
        return null;
      }),
      tryRegisterCurrentAppTarget().catch((error) => {
        getLogger().verbose(`Failed to get current app target: ${error}`);
        return null;
      }),
    ]).then(([a11yInfo, appTarget]) => ({ a11yInfo, appTarget }));

    const audio = await getLogger().stopwatch("stopRecording", async () => {
      try {
        const [, outAudio] = await Promise.all([
          sendPhaseToPill("loading"),
          invokeStopRecording(),
        ]);
        getLogger().verbose(
          `Recording stopped (samples=${outAudio?.samples?.length ?? 0})`,
        );
        return outAudio;
      } catch (error) {
        getLogger().error(`Failed to stop recording: ${error}`);
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage: "Failed to stop recording",
            }),
            toastType: "error",
            duration: 8_000,
          }),
        );
        return null;
      }
    });

    return { audio, context };
  }, [intl, sendPhaseToPill]);

  const processFinalizedRecording = useCallback(
    ({
      audio,
      a11yInfo,
      appTarget,
      toneId,
      rawTranscript,
      transcribeResult,
    }: FinalizedRecording): Promise<RawStopResp> => {
      const session = sessionRef.current;
      const strategy = strategyRef.current;
      if (!session || !strategy) {
        getLogger().warning(
          `stopRecordingRaw: refs cleared (session=${!!session}, strategy=${!!strategy})`,
        );
        return Promise.resolve({ shouldContinue: false });
      }

      const persistReviewedTranscript = async ({
        transcript: reviewedTranscript,
        sanitizedTranscript: reviewedSanitizedTranscript,
        postProcessMetadata: reviewedPostProcessMetadata,
        postProcessWarnings: reviewedPostProcessWarnings,
      }: ReviewedTranscriptPersistenceInput): Promise<boolean> => {
        try {
          const stored = await storeTranscription({
            audio,
            rawTranscript: rawTranscript ?? null,
            sanitizedTranscript: reviewedSanitizedTranscript,
            transcript: reviewedTranscript,
            transcriptionMetadata: transcribeResult.metadata,
            postProcessMetadata: reviewedPostProcessMetadata,
            warnings: [
              ...transcribeResult.warnings,
              ...reviewedPostProcessWarnings,
            ],
            remoteStatus: null,
            remoteDeviceId: null,
          });
          if (stored.transcription) {
            await surfacePersistedReviewInHistory();
            return true;
          }
        } catch (error) {
          getLogger().warning(
            `Could not store the reviewed transcript: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await showToast({
          message: formatReviewPersistenceFailure(
            intl.formatMessage,
            getAppState().userPrefs?.incognitoModeEnabled === true,
          ),
          toastType: "error",
          duration: 8_000,
        });
        return false;
      };

      // Writes the History row with the same arguments the stop path would,
      // so the strategy can start it during delivery. No navigation here:
      // surfacing History belongs to the review's Open action alone.
      const persistTranscriptNow = ({
        transcript: nowTranscript,
        sanitizedTranscript: nowSanitizedTranscript,
        postProcessMetadata: nowPostProcessMetadata,
        postProcessWarnings: nowPostProcessWarnings,
      }: ReviewedTranscriptPersistenceInput) =>
        storeTranscription({
          audio,
          rawTranscript: rawTranscript ?? null,
          sanitizedTranscript: nowSanitizedTranscript,
          transcript: nowTranscript,
          transcriptionMetadata: transcribeResult.metadata,
          postProcessMetadata: nowPostProcessMetadata,
          warnings: [...transcribeResult.warnings, ...nowPostProcessWarnings],
          remoteStatus: null,
          remoteDeviceId: null,
          trace: pipelineTraceRef.current,
        });

      return postProcessFinalizedTranscript({
        audio,
        a11yInfo,
        appTarget,
        toneId,
        rawTranscript,
        transcribeResult,
        strategy,
        isAgentMode: getAppState().activeRecordingMode === "agent",
        handleTranscriptTimeoutMs: getMyUserPreferences(getAppState())
          ?.reviewBeforeInsert
          ? REVIEW_HANDLE_TRANSCRIPT_TIMEOUT_MS
          : HANDLE_TRANSCRIPT_TIMEOUT_MS,
        sendIdle: () => sendPhaseToPill("idle"),
        storeTranscriptionFn: storeTranscription,
        refreshMember,
        showToast,
        persistReviewedTranscript,
        persistTranscriptNow,
        trace: pipelineTraceRef.current,
      });
    },
    [sendPhaseToPill],
  );

  const finalizeAndPostProcess = useCallback(
    async ({
      audio,
      context,
    }: {
      audio: StopRecordingResponse;
      context: Promise<StopContext>;
    }): Promise<RawStopResp> => {
      getLogger().info("Finalizing transcription session");
      // Transcription needs only the audio, so it starts before the focus
      // context and style persistence below instead of queueing behind them.
      const transcription = withTimeout(
        sessionRef.current?.finalize(audio) ?? Promise.resolve(undefined),
        FINALIZE_TIMEOUT_MS,
        "Transcription finalize",
      );
      transcription.catch(() => undefined);

      const { a11yInfo, appTarget } = await context;
      trackAppUsed(appTarget?.name ?? "Unknown");

      if (appTarget) {
        // Awaited so a fast next dictation cannot read the stale app tone
        // and clobber the live selection the user just switched to.
        await saveManualStyleForApp(appTarget);
      }

      // Manual mode: ONE style applies to the whole utterance and the LATEST
      // selection while recording wins. The stop snapshot (captured in
      // stopRecording) is the authoritative style, so a mid-dictation switch
      // (pill / hotkey / Left-Right) restyles the ENTIRE final transcript,
      // not just the words spoken after the switch — and, because the switch
      // also persists the selection, it becomes the default for the next
      // recording. toneIdAtStart is only the last-resort fallback when the
      // stop snapshot was never taken. Automatic mode prefers the app-target
      // tone and falls back to the live selection when the app has none.
      // Streamed interim text is never restyled here — DictationStrategy
      // skips post-processing once segments are inserted.
      const utteranceTones = utteranceTonesRef.current.read();
      const toneId = getEffectiveToneIdAtFinalize({
        stylingMode: getEffectiveStylingMode(getAppState()),
        toneIdAtStart: utteranceTones.start,
        toneIdAtStop: utteranceTones.stop,
        liveSelectedToneId: getManuallySelectedToneId(getAppState()),
        appTargetToneId: appTarget?.toneId ?? null,
      });
      const transcribeResult = await transcription;
      markPipeline(pipelineTraceRef.current, "audioFinalized");
      if (!pipelineTraceRef.current?.marks.transcribed) {
        markPipeline(pipelineTraceRef.current, "transcribed");
      }
      const rawTranscript = transcribeResult?.rawTranscript;
      getLogger().verbose(
        `Transcription result: rawTranscript=${rawTranscript ? `${rawTranscript.length} chars` : "empty"}, toneId=${toneId ?? "none"}, app=${appTarget?.name ?? "unknown"}`,
      );

      if (!rawTranscript || !transcribeResult) {
        if (strategyRef.current) {
          await handleEmptyTranscriptionResult({
            audio,
            transcribeResult,
            strategy: strategyRef.current,
            formatMessage: intl.formatMessage,
            showToast,
            storeTranscriptionFn: storeTranscription,
            refreshMember,
          });
        }
        getLogger().warning("stopRecordingRaw: no rawTranscript from finalize");
        return { shouldContinue: false };
      }

      return processFinalizedRecording({
        audio,
        a11yInfo,
        appTarget,
        toneId,
        rawTranscript,
        transcribeResult,
      });
    },
    [processFinalizedRecording],
  );

  const stopRecordingRaw = useCallback(async (): Promise<RawStopResp> => {
    const ownedAudioChunkUnlisten = audioChunkUnlistenRef.current;
    getLogger().info("Stopping recording");
    clearRecordingTimers();
    // The recording is over from here, so the dim is ended now rather than after
    // transcription finishes below. A dim this recording started can still be in
    // flight: it reads the system volume and writes the dimmed one, and a stop
    // landing between the two has nothing to put back. Ending the dim here is
    // what makes that dim give up, so it cannot apply after the stop with no
    // restore following it.
    systemVolumeDim.endRecording();

    try {
      const { audio, context } = await captureStopRecordingInfo();
      if (!audio) {
        getLogger().warning("stopRecordingRaw: no audio data received");
        return {
          shouldContinue: false,
          abortMessage: "No audio data received",
        };
      }
      sendPillStageText(intl.formatMessage({ defaultMessage: "Transcribing" }));
      return await finalizeAndPostProcess({ audio, context });
    } catch (error) {
      const errorName = error instanceof Error ? ` [name=${error.name}]` : "";
      getLogger().error(`Error during stopRecording: ${error}${errorName}`);
      clearUtteranceToneSnapshots();
      return {
        shouldContinue: false,
        abortMessage: String(error),
      };
    } finally {
      if (audioChunkUnlistenRef.current === ownedAudioChunkUnlisten) {
        ownedAudioChunkUnlisten?.();
        audioChunkUnlistenRef.current = null;
      }
      // Phase convergence: every stop path (success, error, watchdog
      // timeout) must return the pill to idle.
      await sendPhaseToPill("idle");
    }
  }, [
    captureStopRecordingInfo,
    clearRecordingTimers,
    clearUtteranceToneSnapshots,
    finalizeAndPostProcess,
    sendPhaseToPill,
    systemVolumeDim,
    intl,
  ]);

  const stopRecording = useCallback(async () => {
    if (isStoppingRef.current) {
      getLogger().info("stopRecording skipped (already stopping)");
      return;
    }

    const hasOnboarded = getIsOnboarded(getAppState());
    if (hasOnboarded) {
      delayed(2000).then(() => recordStreak());
    }

    getLogger().info("stopRecording entered");
    isStoppingRef.current = true;
    setIsStopping(true);
    pipelineTraceRef.current = startPipelineTrace();
    markPipeline(pipelineTraceRef.current, "stopped");
    sendPillStageText(
      intl.formatMessage({ defaultMessage: "Finalizing audio" }),
    );
    // Capture the live tone at stop: this is the style the whole utterance is
    // finalized with, so a mid-dictation style switch restyles the entire
    // transcript (and, being persisted, starts the next recording too).
    utteranceTonesRef.current.snapshotAtStop(
      getToneIdToUse(getAppState(), {
        currentAppToneId: null,
      }),
    );
    try {
      const res = await stopRecordingRaw().catch((error) => {
        getLogger().error(
          `Error during stopRecording: ${error}${error instanceof Error ? ` [name=${error.name}, stack=${error.stack}]` : ""}`,
        );
        return {
          shouldContinue: false,
          abortMessage: String(error),
        };
      });

      getLogger().info(
        `stopRecording result: shouldContinue=${res.shouldContinue}, abortMessage=${res.abortMessage ?? "none"}`,
      );
      if (!res.shouldContinue) {
        await abortRecording(
          res.abortMessage ? { body: res.abortMessage } : undefined,
        );
      }
    } finally {
      // Invalidate the operation token so an in-flight start tail can never arm
      // timers for this recording now that it has ended. The dim is not guarded
      // by this token: it retired at the top of `stopRecordingRaw`, where a stop
      // becomes a stop rather than waiting for transcription first.
      recordingOperationRef.current += 1;
      // Timers must be cleared even when the transcribe chain fails or the
      // watchdog fires, so no stale auto-stop can fire into the next session.
      clearRecordingTimers();
      hardResetHotkeyState();
      isStoppingRef.current = false;
      setIsStopping(false);
      // Finalize has already read the snapshots. Drop them so a later
      // session cannot inherit this utterance's tone if start is raced.
      clearUtteranceToneSnapshots();
    }
  }, [
    abortRecording,
    clearRecordingTimers,
    clearUtteranceToneSnapshots,
    hardResetHotkeyState,
    stopRecordingRaw,
    setIsStopping,
    intl,
  ]);

  const startUserRecordingTimers = useCallback(() => {
    clearUserRecordingTimers();

    const state = getAppState();
    const preferences = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    const dictationLimitMinutes = shouldEnableDictationLimit(
      transcriptionPrefs.mode,
    )
      ? getEffectiveDictationLimitMinutes(preferences)
      : DEFAULT_DICTATION_LIMIT_MINUTES;
    const { warningDurationMs, autoStopDurationMs } =
      getDictationRecordingTimerDurations(dictationLimitMinutes);

    if (warningDurationMs !== null) {
      recordingWarningTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Recording duration warning (${dictationLimitMinutes} min limit)`,
        );
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage: "Recording will stop in 60 seconds",
            }),
            toastType: "info",
            duration: 5_000,
          }),
        );
      }, warningDurationMs);
    }

    if (autoStopDurationMs !== null) {
      recordingAutoStopTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Recording auto-stopped (${dictationLimitMinutes} min limit)`,
        );
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage: "Recording stopped: duration limit reached",
            }),
            toastType: "info",
            duration: 5_000,
          }),
        );
        void stopRecording();
      }, autoStopDurationMs);
    }
  }, [clearUserRecordingTimers, intl, stopRecording]);

  const startProviderRecordingTimers = useCallback(() => {
    clearProviderRecordingTimers();

    const providerLimitMs =
      sessionRef.current?.getMaximumRecordingDurationMs?.() ?? null;
    const { warningDurationMs, autoStopDurationMs } =
      getProviderRecordingTimerDurations(providerLimitMs);
    if (autoStopDurationMs === null) {
      return;
    }

    if (warningDurationMs !== null) {
      providerWarningTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Provider recording duration warning (${providerLimitMs} ms limit)`,
        );
        runToast(
          showToast({
            message: intl.formatMessage({
              defaultMessage:
                "Provider limit: recording will stop in 60 seconds",
            }),
            toastType: "info",
            duration: 5_000,
          }),
        );
      }, warningDurationMs);
    }
    providerAutoStopTimerRef.current = setTimeout(() => {
      getLogger().warning(
        `Recording auto-stopped at provider limit (${providerLimitMs} ms)`,
      );
      runToast(
        showToast({
          message: intl.formatMessage({
            defaultMessage:
              "Recording stopped: provider duration limit reached",
          }),
          toastType: "info",
          duration: 5_000,
        }),
      );
      void stopRecording();
    }, autoStopDurationMs);
  }, [clearProviderRecordingTimers, intl, stopRecording]);

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
    ): Promise<boolean> => {
      if (
        mode !== "dictate" ||
        state.onboarding.dictationOverrideEnabled ||
        state.local.disableAutoStyleLoading
      ) {
        return true;
      }
      await loadManualStyleForCurrentApp();
      if (recordingOperationRef.current !== attempt) {
        getLogger().warning(
          "Recording start was aborted or replaced while loading the style",
        );
        return false;
      }
      return true;
    },
    [],
  );

  /**
   * Unwinds a start that threw.
   *
   * Extracted from `startRecording` because this block is almost entirely
   * branches, and inlining it here was what pushed the function over the
   * cognitive-complexity limit. The behaviour is unchanged.
   */
  const handleStartFailure = useCallback(
    (
      error: unknown,
      activeSession: TranscriptionSession | null,
      operationId: number,
    ): void => {
      if (operationId !== recordingOperationRef.current) {
        getLogger().warning(
          "Start failed after a newer recording took over; ignoring stale failure",
        );
        activeSession?.cleanup();
        return;
      }
      getLogger().error(`Failed to start recording: ${error}`);

      activeSession?.cleanup();
      if (sessionRef.current === activeSession) {
        sessionRef.current = null;
        strategyRef.current = null;
      }
      clearRecordingState();
      // This handler is sync and cannot await, but the call still has to be
      // marked discarded so it is not a floating promise. `abortRecording`
      // guards its own awaits, so nothing here can reject.
      void abortRecording();

      hardResetHotkeyState();
      clearRecordingTimers();
      invoke("stop_recording").catch((e) =>
        getLogger().verbose(
          `stop_recording failed during error handling: ${e}`,
        ),
      );

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
    [
      abortRecording,
      clearRecordingState,
      clearRecordingTimers,
      hardResetHotkeyState,
    ],
  );

  const startRecording = useCallback(
    async (args: { mode: RecordingMode; language?: string | null }) => {
      const attempt = ++recordingOperationRef.current;
      const state = getAppState();
      const mode = args.mode;
      const language = args.language || getMyPrimaryDictationLanguage(state);
      produceAppState((draft) => {
        draft.activeRecordingMode = mode;
        draft.dictationLanguageOverride = language;
      });

      const strategy = resolveRecordingStrategy(mode, strategyRef.current);

      const validationError = strategy.validateAvailability();
      if (validationError) {
        abortRecording({
          title: validationError.title,
          body: validationError.body,
        });
        return;
      }

      // Extracted with the rest of the start-failure handling: another nested
      // branch set that was counting against `startRecording`'s cognitive
      // complexity. False means a newer start took over while the style loaded,
      // so the caller must stop.
      if (!(await prepareAutoStyle(mode, state, attempt))) {
        return;
      }

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
      let activeSession: TranscriptionSession | null = null;
      try {
        getLogger().info(`Transcription prefs: mode=${transcriptPrefs.mode}`);
        const session = createTranscriptionSession(transcriptPrefs);
        activeSession = session;
        getLogger().info(
          `Created transcription session: ${session.constructor.name}`,
        );

        let audioForwardingReady = false;
        const isCurrentStart = () =>
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

        const intake = await attachSessionAudioIntake(
          session,
          isCurrentStart,
          () => audioForwardingReady,
          (droppedSamples) => {
            getLogger().warning(
              `[Dictation] Startup audio buffer overflowed; dropped ${droppedSamples} samples`,
            );
          },
        );
        const startupAudioBuffer = intake.buffer;
        if (!intake.current) {
          session.cleanup();
          return;
        }
        audioChunkUnlistenRef.current?.();
        audioChunkUnlistenRef.current = intake.unlisten;

        tryPlayAudioChime("start_recording_clip");
        if (session.supportsStreaming()) {
          session.setInterimResultCallback(
            createCurrentSegmentGuard(
              operationId,
              () => recordingOperationRef.current,
              (segment) => strategy.handleInterimSegment(segment),
            ),
          );
        }

        await strategy.onBeforeStart();
        if (!isCurrentStart()) {
          session.cleanup();
          return;
        }

        getLogger().info(
          `Starting recording (mic=${preferredMicrophone ?? "default"})`,
        );
        isPausedRef.current = false;
        nativeStartOwnerRef.current = operationId;
        // Give the session its audio_chunk subscription before the microphone
        // opens. Tauri does not replay events, so anything captured while the
        // sidecar is still loading would otherwise be lost, which is the first
        // words of the dictation. A session that takes no live audio resolves
        // immediately, and a failure here is not fatal: the session falls back
        // to transcribing the whole recording at stop.
        //
        // The catch is what makes that last sentence true. The hook is optional
        // and newly added to the interface, so an implementation is free to
        // throw from it; without a guard here that rejection landed in the outer
        // catch, which aborted the recording and showed "Recording failed" for a
        // start that had not begun. It only behaved because the one local
        // implementation happens to swallow its own errors.
        try {
          await session.onBeforeRecordingStart?.();
        } catch (error) {
          getLogger().warning(
            `Pre-capture session setup failed, continuing without it: ${error}`,
          );
        }
        if (!isCurrentStart()) {
          session.cleanup();
          return;
        }
        const [, startRecordingResult] = await Promise.all([
          strategy.setPhase("recording"),
          invoke<StartRecordingResponse>("start_recording", {
            args: { preferredMicrophone },
          }).then((result) => {
            // The phase update can outlive microphone startup. Anchor provider
            // wall-clock limits at the instant native capture succeeds rather
            // than waiting for the other Promise.all branch.
            if (isCurrentStart()) {
              startProviderRecordingTimers();
            }
            return result;
          }),
        ]);

        const sampleRate = startRecordingResult.sampleRate;
        startupAudioBuffer.setSampleRate(sampleRate);
        getLogger().verbose(`Recording started (sampleRate=${sampleRate})`);

        // A stop/abort can arrive while `start_recording` is still opening
        // the mic (WASAPI init can take >1s on loaded machines).
        // `abortRecording` nulls the refs, so require the refs to still match
        // this invocation's session before continuing. Reading and invoking a
        // nullable current ref here previously crashed when the user stopped
        // mid-initialization.
        if (!isCurrentStart()) {
          getLogger().warning(
            "Recording start raced an abort or replacement; stopping the stale native stream",
          );
          await stopOwnedNativeStart(nativeStartOwnerRef, operationId);
          return;
        }
        nativeStartOwnerRef.current = null;
        const startedSession = session;

        await startedSession.onRecordingStart(sampleRate);

        if (!isCurrentStart()) {
          getLogger().warning(
            "Session was aborted while starting; skipping timers",
          );
          startedSession.cleanup();
          return;
        }

        startupAudioBuffer.setSink((chunk, offset) => {
          forwardAudioChunk(startedSession, chunk, offset);
        });
        startupAudioBuffer.replay();
        startupAudioBuffer.reset();
        audioForwardingReady = true;

        // Keep the user-configured active-audio timers at their established
        // start point after session initialization succeeds.
        startUserRecordingTimers();
        // Fire-and-forget. `startRecording` is an onActivate handler and the
        // activation controller serialises activate before deactivate, so
        // awaiting here would put the volume round trips in front of the stop
        // that the user's key release triggers, keeping the microphone open past
        // release. The dim retires itself on its own operation id, and every stop
        // path ends it before awaiting anything, so a stop landing mid-dim is
        // handled without awaiting.
        void systemVolumeDim.dim(operationId);
      } catch (error) {
        handleStartFailure(error, activeSession, operationId);
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

  const startDictationRecording = useCallback(async () => {
    const state = getAppState();
    if (!getIsDictationUnlocked(state)) {
      getLogger().verbose("Dictation not unlocked, ignoring start");
      return;
    }
    if (state.pendingPillReview !== null) {
      getLogger().info("Dictation blocked: review is pending");
      playAlertSound();
      return;
    }

    getLogger().info("Starting dictation recording");
    trackDictationStart();
    produceAppState((draft) => {
      draft.local.lastDictatedAt = Date.now();
    });

    await startRecording({ mode: "dictate" });
  }, [startRecording]);

  const stopDictationRecording = useCallback(async () => {
    getLogger().info("Stopping dictation recording");
    await stopRecording();
  }, [stopRecording]);

  const startAgentRecording = useCallback(async () => {
    const state = getAppState();
    if (!getIsDictationUnlocked(state)) {
      getLogger().verbose("Dictation not unlocked, ignoring agent start");
      return;
    }
    if (state.pendingPillReview !== null) {
      getLogger().info("Agent start blocked: review is pending");
      playAlertSound();
      return;
    }

    if (state.assistantInputMode === "type") {
      getLogger().info("Switching from type mode back to voice mode");
      produceAppState((draft) => {
        draft.assistantInputMode = "voice";
      });
    }

    getLogger().info("Starting agent recording");
    trackAgentStart();
    await startRecording({ mode: "agent" });
  }, [startRecording]);

  const stopAgentRecording = useCallback(async () => {
    getLogger().info("Stopping agent recording");
    await stopRecording();
  }, [stopRecording]);

  const handleSwitchWritingStyleForward = useCallback(
    () =>
      applyInDictationStyleSwitch({ channel: "cycle-hotkey", direction: 1 }),
    [],
  );

  const handleSwitchWritingStyleBackward = useCallback(
    () =>
      applyInDictationStyleSwitch({ channel: "cycle-hotkey", direction: -1 }),
    [],
  );

  const promptCancelTranscription = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearCancelPromptTimer();
      runToast(dismissToast());
      void abortRecording();
      return;
    }

    const CANCEL_PROMPT_DURATION = 5_000;
    cancelPromptTimerRef.current = setTimeout(() => {
      cancelPromptTimerRef.current = null;
    }, CANCEL_PROMPT_DURATION);

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

  useEffect(() => {
    const previous = new Set(
      previousStyleSwitchKeysRef.current.map((key) => key.toLowerCase()),
    );
    const current = new Set(keysHeld.map((key) => key.toLowerCase()));
    // Combos are subscribed via `dictateCombos` so we don't rebuild them
    // on every keysHeld change. While dictation is active and the
    // activation key is held, Left/Right cycles the writing style.
    const activationHeld = isActivationComboHeld(dictateCombos, current);
    const newlyPressed = resolveNewlyPressedDictationArrow(current, previous);
    const arrowDirection = resolveInDictationArrowStyleSwitch({
      enabled: inDictationStyleSwitchingEnabled,
      isMainWindow,
      isActiveDictateSession:
        isActiveSession && activeRecordingMode === "dictate",
      isManualStyling,
      activationHeld,
      newlyPressed,
    });
    if (arrowDirection === "forward") {
      void applyInDictationStyleSwitch({ channel: "arrows", direction: 1 });
    } else if (arrowDirection === "backward") {
      void applyInDictationStyleSwitch({ channel: "arrows", direction: -1 });
    }

    previousStyleSwitchKeysRef.current = keysHeld;
  }, [
    // `previousStyleSwitchKeysRef` is intentionally excluded: it is a
    // mutation-based snapshot of the prior `keysHeld` updated at the end of this
    // effect, so including it would trigger a render loop.
    activeRecordingMode,
    dictateCombos,
    inDictationStyleSwitchingEnabled,
    isActiveSession,
    isMainWindow,
    isManualStyling,
    keysHeld,
  ]);

  useHotkeyFireMany({
    actions: switchToStyleEntries.map((entry) => ({
      actionName: entry.actionName,
      onFire: () => {
        void applyInDictationStyleSwitch({
          channel: "hotkey",
          toneId: entry.toneId,
        });
      },
    })),
    isDisabled: !isDictationUnlocked || !isMainWindow,
  });

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling || !isMainWindow,
    onFire: handleSwitchWritingStyleForward,
  });

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling || !isMainWindow,
    onFire: handleSwitchWritingStyleBackward,
  });

  useHotkeyHold({
    actionName: DICTATE_HOTKEY,
    isDisabled:
      !isDictationInteractable ||
      activeRecordingMode === "agent" ||
      !isMainWindow,
    controller: dictationController,
    // Only the two style-switch arrows may be held in addition to the
    // activation key, and only after dictation is already active. This keeps
    // Fn+any-key from becoming an accidental hold-to-talk gesture.
    allowedAdditionalKeys:
      inDictationStyleSwitchingEnabled &&
      isManualStyling &&
      activeRecordingMode === "dictate"
        ? IN_DICTATION_STYLE_KEYS
        : undefined,
  });

  useHotkeyHold({
    actionName: AGENT_DICTATE_HOTKEY,
    isDisabled:
      !isDictationInteractable ||
      !assistantModeEnabled ||
      activeRecordingMode === "dictate" ||
      !isMainWindow,
    controller: agentController,
  });

  useHotkeyFire({
    actionName: CANCEL_TRANSCRIPTION_HOTKEY,
    isDisabled: !isActiveSession || !isMainWindow,
    onFire: promptCancelTranscription,
  });

  useHotkeyHoldMany({
    isDisabled:
      !isDictationInteractable ||
      activeRecordingMode === "agent" ||
      !isMainWindow,
    actions: additionalLanguageControllers,
  });

  // Native combo sync lives in AppSideEffects: it subscribes to every
  // grab-relevant input (session state, styling mode, unlock state, hotkey
  // map, strategy) and repushes on any change, so a per-component effect keyed
  // to just recording/styling state can't leave the listener stale.

  // `loadChatMessages` below is discarded, so a rejection from it would be
  // unhandled rather than reported, and it can reject: it awaits
  // `getChatMessageRepo().listChatMessages(...)` (`chat.actions.ts:288`) with no
  // try/catch of its own, straight through to the Tauri IPC.
  //
  // `surfaceMainWindow()` was named here as a second source and cannot be one --
  // `window.utils.ts:22-35` attaches `.catch()` to the invoke BEFORE awaiting the
  // memoized promise, so `await surfaceWindowPromise` there cannot throw. Naming it
  // would have sent the next reader looking for a rejection that is not reachable.
  const reportConversationOpenFailure = (error: unknown): void => {
    getLogger().warning(
      `Failed to open the conversation: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  const openPillConversation = useCallback(
    async (conversationId?: string) => {
      const id = conversationId ?? getAppState().pillConversationId;
      if (id) {
        void loadChatMessages(id).catch(reportConversationOpenFailure);
        // `navigate` returns a promise; a rejection here would otherwise be
        // unhandled, so it is caught on the promise rather than by a surrounding
        // try/catch that cannot see it.
        await getBrowserRouter()
          .navigate(`/dashboard/chats?id=${encodeURIComponent(id)}`)
          .catch((error: unknown) => {
            getLogger().warning(
              `Failed to navigate to the conversation: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      await surfaceMainWindow();
      await abortRecording();
    },
    [abortRecording],
  );

  useTauriListen<void>("assistant-mode-close", async () => {
    if (!isMainWindow) return;
    await abortRecording();
  });

  useTauriListen<void>("assistant-enable-type-mode", () => {
    if (!isMainWindow) return;
    getLogger().info("Switching to type mode");

    // Stop the microphone/transcription without tearing down the assistant panel
    recordingOperationRef.current += 1;
    systemVolumeDim.endRecording();
    clearRecordingTimers();
    hardResetHotkeyState();
    releaseAudioIntake();
    invoke<void>("set_phase", { phase: "idle" }).catch(console.error);
    invoke("stop_recording").catch((e) =>
      getLogger().verbose(
        `stop_recording failed during type mode switch: ${e}`,
      ),
    );
    sessionRef.current?.cleanup();
    sessionRef.current = null;
    clearUtteranceToneSnapshots();

    produceAppState((draft) => {
      draft.assistantInputMode = "type";
    });
  });

  useTauriListen<{ text: string }>(
    "assistant-typed-message",
    async (payload) => {
      if (!isMainWindow) return;
      const { text } = payload;
      if (!text.trim()) return;

      let conversationId = getAppState().pillConversationId;
      if (!conversationId) {
        const now = new Date().toISOString();
        const conversation = await createConversation({
          id: createId(),
          title: intl.formatMessage({
            defaultMessage: "New conversation",
          }),
          createdAt: now,
          updatedAt: now,
        });
        conversationId = conversation.id;
        produceAppState((draft) => {
          draft.pillConversationId = conversation.id;
        });
      }

      getLogger().info(`Sending typed message (${text.length} chars)`);
      sendChatMessage(conversationId, text).catch((error) => {
        getLogger().error(`Failed to send typed message: ${error}`);
      });
    },
  );

  useTauriListen<{ conversationId: string }>(
    "open-pill-conversation",
    (payload) => {
      if (!isMainWindow) return;
      void openPillConversation(payload.conversationId).catch(
        reportConversationOpenFailure,
      );
    },
  );

  useHotkeyFire({
    actionName: OPEN_CHAT_HOTKEY,
    isDisabled: !isMainWindow,
    // `onFire` is typed `() => void` and `desktop-utils/src/hotkey.ts` calls it
    // bare (`onFire?.()` at :332 and :342), so handing it an async function
    // discards the promise with nobody to catch a rejection. That is the third
    // discard path on this function, and the one my previous commit named while
    // leaving it in place. Wrapping here rather than in the shared hotkey helper
    // keeps the fix local to a caller that has a logger, and keeps every other
    // `onFire` caller untouched.
    onFire: () => {
      void openPillConversation().catch(reportConversationOpenFailure);
    },
  });

  const pauseDictation = useCallback(async () => {
    if (isPausedRef.current || isStoppingRef.current) {
      return;
    }
    if (!sessionRef.current || !strategyRef.current) {
      return;
    }
    if (getAppState().activeRecordingMode === null) {
      return;
    }
    try {
      getLogger().info("Pausing dictation");
      // Hold mic capture without finalizing the session so the user can resume.
      await invoke("pause_recording");
      isPausedRef.current = true;
      // User-configured timers measure active audio. Provider hard limits are
      // wall-clock limits and intentionally continue while paused.
      clearUserRecordingTimers();
      // Keep the voice field fully open and slide the style bar in via paused phase.
      await strategyRef.current.setPhase("paused");
      // Fire-and-forget: a toast that fails to render is not a failure to pause,
      // and awaiting it here would report one as "Failed to pause dictation".
      runToast(
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Dictation paused",
          }),
          toastType: "info",
          duration: 2_000,
        }),
      );
    } catch (error) {
      getLogger().error(`Failed to pause dictation: ${error}`);
    }
  }, [clearUserRecordingTimers, intl]);

  const resumeDictation = useCallback(async () => {
    if (!isPausedRef.current || isStoppingRef.current) {
      return;
    }
    if (!sessionRef.current || !strategyRef.current) {
      return;
    }
    try {
      getLogger().info("Resuming dictation");
      await invoke("resume_recording");
      isPausedRef.current = false;
      await strategyRef.current.setPhase("recording");
      startUserRecordingTimers();
    } catch (error) {
      getLogger().error(`Failed to resume dictation: ${error}`);
      // Fire-and-forget, and deliberately not awaited inside the catch: a toast
      // that cannot render must not turn into a second "failed to resume" error.
      runToast(
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Could not resume dictation",
          }),
          toastType: "error",
          duration: 5_000,
        }),
      );
    }
  }, [intl, startUserRecordingTimers]);

  useTauriListen<void>("cancel-dictation", () => {
    if (!isMainWindow) return;
    void abortRecording();
  });

  useTauriListen<void>("pause-dictation", () => {
    if (!isMainWindow) return;
    void pauseDictation();
  });

  useTauriListen<void>("resume-dictation", () => {
    if (!isMainWindow) return;
    logResumeFailure(resumeDictation());
  });

  useToastAction(async (payload) => {
    if (payload.action === "confirm_cancel_transcription") {
      if (!isMainWindow) return;
      await abortRecording();
    }
  });

  useTauriListen<void>("on-click-dictate", () => {
    const intent = resolvePillBodyClickIntent({
      isMainWindow,
      isDictationInteractable,
      isPaused: isPausedRef.current,
    });
    if (intent === "resume") {
      logResumeFailure(resumeDictation());
      return;
    }
    if (intent === "toggle") {
      debouncedToggle("dictation", dictationController);
    }
  });

  useTauriListen<void>("on-click-agent-talk", () => {
    if (isMainWindow && isDictationInteractable) {
      debouncedToggle("agent", agentController);
    }
  });

  useTauriListen<void>("tone-switch-forward", () => {
    if (!isMainWindow) return;
    void applyInDictationStyleSwitch({ channel: "pill", direction: 1 });
  });

  useTauriListen<void>("tone-switch-backward", () => {
    if (!isMainWindow) return;
    void applyInDictationStyleSwitch({ channel: "pill", direction: -1 });
  });

  useTauriListen<OverlayResolvePermissionPayload>(
    "overlay-resolve-permission",
    (payload) => {
      if (!isMainWindow) return;
      if (payload.alwaysAllow) {
        const permission =
          getAppState().toolPermissionById[payload.permissionId];
        if (permission) {
          setToolAlwaysAllow({
            toolId: permission.toolId,
            params: permission.params,
            allowed: true,
            scope: `conversation:${permission.conversationId}`,
          });
        }
      }
      resolveToolPermission(payload.permissionId, payload.status);
    },
  );

  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_pill_visibility", { visibility: pillVisibility }).catch(
      console.error,
    );
  }, [pillVisibility]);

  const pillHasContent = useAppStore((state) => {
    if (!state.pillConversationId) return false;
    const ids =
      state.chatMessageIdsByConversationId[state.pillConversationId] ?? [];
    if (ids.length > 0) return true;
    return Object.values(state.toolPermissionById).some(
      (p) =>
        p.conversationId === state.pillConversationId && p.status === "pending",
    );
  });

  useEffect(() => {
    if (!isMainWindow) return;
    const size = resolvePillWindowSize({
      hasPendingReview,
      isAgentRecording: activeRecordingMode === "agent",
      isAssistantTyping: assistantInputMode === "type",
      pillHasContent,
    });
    invoke("set_pill_window_size", { size }).catch(console.error);
  }, [
    activeRecordingMode,
    pillHasContent,
    assistantInputMode,
    hasPendingReview,
  ]);

  // Sync style info to native GTK4 pill
  const pillStyleCount = useAppStore((state) => {
    if (getEffectiveStylingMode(state) !== "manual") return 0;
    return getActiveManualToneIds(state).length;
  });
  const pillStyleName = useAppStore((state) => {
    const toneId = getManuallySelectedToneId(state);
    return getToneById(state, toneId)?.name ?? "-";
  });

  useEffect(() => {
    if (!isMainWindow) return;
    invoke("notify_pill_style_info", {
      count: pillStyleCount,
      name: pillStyleName,
    }).catch(console.error);
  }, [pillStyleCount, pillStyleName]);

  return null;
};
