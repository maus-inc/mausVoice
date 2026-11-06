import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { tryRegisterCurrentAppTarget } from "../../actions/app-target.actions";
import { refreshMember } from "../../actions/member.actions";
import {
  dismissMicrophoneSafetyToast,
  dismissToastForAction,
  runToast,
  showToast,
} from "../../actions/toast.actions";
import { storeTranscription } from "../../actions/transcribe.actions";
import { getAppState } from "../../store";
import { failedCaptureResult } from "../../sessions/recording-transcription.utils";
import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TextFieldInfo } from "../../types/accessibility.types";
import type { OverlayPhase } from "../../types/overlay.types";
import type {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../../types/transcription-session.types";
import { tryPlayAudioChime } from "../../utils/audio.utils";
import { getLogger } from "../../utils/log.utils";
import { sendPhaseWithoutWaiting } from "../../utils/phase-delivery.utils";
import {
  markFinalizedTranscription,
  type PipelineTrace,
} from "../../utils/pipeline-trace";
import type { NativeRecordingLeaseRef } from "./dictation-recording-intake";
import type { NativeRecordingLease } from "../../utils/native-recording-lease";
import { withTimeout } from "../../utils/timeout.utils";
import { getMyUserPreferences } from "../../utils/user.utils";
import {
  prepareFinalizationContext,
  logFinalizationSummary,
  type StopContext,
} from "./dictation-finalize-context";
import { createReviewedTranscriptPersistence } from "./dictation-review-persistence";
import type {
  FinalizedRecording,
  HandleEmptyResultInput,
  PostTranscriptInput,
  RawStopResp,
} from "./dictation-finalization.types";

const FINALIZE_TIMEOUT_MS = 90_000;
const FOCUS_CONTEXT_TIMEOUT_MS = 2_000;
const STOP_RECOVERY_WAIT_MS = 5_000;
const STOP_RECOVERY_RETRY_DELAY_MS = 1_000;
// Match the retained-copy lifetime: waiting longer cannot produce audio.
const STOP_RECOVERY_DEADLINE_MS = 60_000;
const STOP_CANCEL_PROMPT_DELAY_MS = 8_000;
const STOP_CANCEL_PROMPT_DURATION_MS = 30_000;

/**
 * Retry a lost stop reply against the lease's own recovery, bounded by the
 * lease's retention. A timeout, a retired owner, or an expired lease ends the
 * wait, and nothing is acknowledged here: the audio either arrives or the caller
 * reports the failure.
 */
const awaitStopRecovery = async (
  lease: NativeRecordingLease | null,
  isCurrent: () => boolean,
  onExpire: () => void,
): Promise<StopRecordingResponse | null> => {
  onExpire();
  if (!lease || !isCurrent()) return null;
  const recoveryDeadline = Date.now() + STOP_RECOVERY_DEADLINE_MS;
  while (isCurrent() && Date.now() < recoveryDeadline && lease.canRecoverStop) {
    const recovered = await lease
      .waitForStopRecovery(STOP_RECOVERY_WAIT_MS, isCurrent)
      .catch(() => null);
    if (recovered) return recovered;
    if (!isCurrent() || !lease.canRecoverStop) break;
    // Failed IPC may reject immediately. Pace retries without discarding the
    // admission or blocking explicit cancellation.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, STOP_RECOVERY_RETRY_DELAY_MS),
    );
  }
  return null;
};

/** Drop a stop context nobody will await, without an unhandled rejection. */
const releaseStopContext = (context: Promise<unknown>): void => {
  void context.catch(() => undefined);
};

/** Release a session's resources; a failure here must not mask the outcome. */
const cleanupSessionQuietly = (session: { cleanup: () => void }): void => {
  try {
    session.cleanup();
  } catch {
    getLogger().warning("Transcription session cleanup failed");
  }
};

/**
 * Finalize under a deadline. A hang, a throw, or a synchronous transport error
 * becomes a warning attached to the audio, so the recording stays recoverable
 * instead of leaving the stop path without a result.
 */
const finalizeSessionWithDeadline = (
  session: {
    cleanup: () => void;
    finalize: (
      audio: StopRecordingResponse,
    ) => Promise<TranscriptionSessionResult>;
  },
  audio: StopRecordingResponse,
): Promise<TranscriptionSessionResult> => {
  let resultPromise: Promise<TranscriptionSessionResult>;
  try {
    resultPromise = session.finalize(audio);
  } catch (error) {
    resultPromise = Promise.reject(error);
  }
  return withTimeout(
    resultPromise,
    FINALIZE_TIMEOUT_MS,
    "Transcription finalize",
  ).catch((): TranscriptionSessionResult => {
    cleanupSessionQuietly(session);
    return {
      rawTranscript: null,
      metadata: {},
      warnings: ["Transcription could not be completed"],
    };
  });
};
const HANDLE_TRANSCRIPT_TIMEOUT_MS = 60_000;
// Review-before-insert can remain open for its 5-minute decision window on
// either the native pill or the composer fallback. Budget the wrapper above
// that plus slack: a wrapper smaller than the review window would reject
// mid-review, skip storeTranscription below, and silently drop the transcript
// from history while the review could still insert on Save.
const REVIEW_HANDLE_TRANSCRIPT_TIMEOUT_MS = 6 * 60_000;

/** Coordinate audio stop, contextual tone selection and transcript processing. */
export function useRecordingFinalization({
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
}: {
  sessionRef: { current: TranscriptionSession | null };
  strategyRef: { current: BaseStrategy | null };
  pipelineTraceRef: { current: PipelineTrace | null };
  utteranceTonesRef: {
    current: { read: () => { start: string | null; stop: string | null } };
  };
  nativeStartOwnerRef: NativeRecordingLeaseRef;
  sendPhaseToPill: (phase: OverlayPhase) => Promise<void>;
  postProcessFinalizedTranscript: (
    input: PostTranscriptInput,
  ) => Promise<RawStopResp>;
  handleEmptyTranscriptionResult: (
    input: HandleEmptyResultInput,
  ) => Promise<{ handled: boolean }>;
  surfacePersistedReviewInHistory: (isCurrent: () => boolean) => Promise<void>;
  formatReviewPersistenceFailure: (
    formatMessage: (descriptor: { defaultMessage: string }) => string,
    incognito: boolean,
  ) => string;
}) {
  const intl = useIntl();
  const captureStopRecordingInfo = useCallback(
    async (
      isCurrent: () => boolean = () => true,
    ): Promise<{
      audio: StopRecordingResponse | null;
      context: Promise<StopContext>;
    }> => {
      const lease = nativeStartOwnerRef.current;
      let stop: Promise<StopRecordingResponse>;
      try {
        if (!lease) throw new Error("Missing recording lease");
        stop = lease.stop();
      } catch (error) {
        stop = Promise.reject(error);
      }
      let cancelPromptTimer: ReturnType<typeof setTimeout> | null = null;
      let cancelPromptInterval: ReturnType<typeof setInterval> | null = null;
      const isStopOwnerCurrent = () =>
        !!lease && nativeStartOwnerRef.current === lease && isCurrent();
      const showCancelPrompt = () => {
        if (!lease || !isStopOwnerCurrent()) return;
        try {
          runToast(
            showToast({
              message: intl.formatMessage({
                defaultMessage: "Finalizing audio",
              }),
              toastType: "info",
              action: "cancel_recording_stop",
              proposalId: lease.ownerId,
              duration: STOP_CANCEL_PROMPT_DURATION_MS,
              isCurrent: isStopOwnerCurrent,
            }),
          );
        } catch {
          getLogger().warning("Could not display the recording cancel prompt");
        }
      };
      // An unresponsive stop is not evidence that the driver released the mic.
      const warnUnconfirmedStop = () => {
        if (!lease || !isStopOwnerCurrent()) return;
        try {
          runToast(
            showToast({
              message: intl.formatMessage({
                defaultMessage:
                  "The microphone may still be in use. If its indicator stays on, quit the app.",
              }),
              toastType: "error",
              microphoneSafetyOwner: lease.ownerId,
              duration: 8_000,
              isCurrent: isStopOwnerCurrent,
            }),
          );
        } catch {
          getLogger().warning("Could not display the microphone safety toast");
        }
        if (cancelPromptTimer === null && cancelPromptInterval === null) {
          cancelPromptTimer = setTimeout(() => {
            cancelPromptTimer = null;
            if (!isStopOwnerCurrent()) return;
            showCancelPrompt();
            cancelPromptInterval = setInterval(
              showCancelPrompt,
              STOP_CANCEL_PROMPT_DURATION_MS,
            );
          }, STOP_CANCEL_PROMPT_DELAY_MS);
        }
      };
      const warningTimer = setTimeout(
        warnUnconfirmedStop,
        STOP_RECOVERY_WAIT_MS,
      );
      // Observe both outcomes without allowing presentation to delay the stop.
      void stop
        .then(
          () => clearTimeout(warningTimer),
          () => {
            clearTimeout(warningTimer);
            warnUnconfirmedStop();
          },
        )
        .catch(() => undefined);
      try {
        if (isCurrent()) tryPlayAudioChime("stop_recording_clip");
      } catch {
        // Feedback is optional; a synchronous audio/IPC failure must not
        // prevent the microphone's normal stop and lose the captured audio.
        getLogger().warning("Could not play the recording stop chime");
      }
      getLogger().verbose("Invoking stop_recording and fetching a11y info");
      // Focus/app lookups (accessibility tree walk, icon extraction, app
      // target upsert) only feed post-processing and history, so they resolve
      // alongside transcription instead of gating the audio handoff.
      let appLookupExpired = false;
      const context = Promise.all([
        withTimeout(
          Promise.resolve().then(() =>
            invoke<TextFieldInfo>("get_text_field_info"),
          ),
          FOCUS_CONTEXT_TIMEOUT_MS,
          "Text field lookup",
        ).catch(() => {
          getLogger().verbose("Failed to get text field info");
          return null;
        }),
        withTimeout(
          Promise.resolve().then(() =>
            tryRegisterCurrentAppTarget(() => !appLookupExpired && isCurrent()),
          ),
          FOCUS_CONTEXT_TIMEOUT_MS,
          "App target lookup",
          () => {
            appLookupExpired = true;
          },
        ).catch(() => {
          getLogger().verbose("Failed to get current app target");
          return null;
        }),
      ]).then(([a11yInfo, appTarget]) => ({ a11yInfo, appTarget }));

      let audio: StopRecordingResponse | null;
      let releaseConfirmed = false;
      try {
        audio = await getLogger().stopwatch("stopRecording", async () => {
          try {
            if (isCurrent())
              sendPhaseWithoutWaiting(sendPhaseToPill, "loading");
            const outAudio = await stop.catch(() =>
              // A lost stop reply may still have a scoped recovery in flight.
              // Do not acknowledge it after a timeout or session retirement.
              awaitStopRecovery(lease, isCurrent, () => {
                appLookupExpired = true;
              }),
            );
            if (!outAudio) throw new Error("Recording audio unavailable");
            // Failed capture bypasses contextual finalization. Retire any app
            // lookup now rather than letting it mutate state while audio is saved.
            if (outAudio.captureFailed) appLookupExpired = true;
            else releaseConfirmed = true;
            if (nativeStartOwnerRef.current === lease)
              nativeStartOwnerRef.current = null;
            getLogger().verbose(
              `Recording stopped (samples=${outAudio?.samples?.length ?? 0})`,
            );
            return outAudio;
          } catch {
            appLookupExpired = true;
            if (!isCurrent()) return null;
            getLogger().error("Failed to stop recording");
            if (lease) {
              // A generic failure toast would replace the earlier safety warning
              // while cancellation or native release can still be blocked.
              warnUnconfirmedStop();
            } else {
              runToast(
                showToast({
                  message: intl.formatMessage({
                    defaultMessage: "Failed to stop recording",
                  }),
                  toastType: "error",
                  duration: 8_000,
                  isCurrent,
                }),
              );
            }
            return null;
          }
        });
      } finally {
        clearTimeout(warningTimer);
        if (cancelPromptTimer !== null) clearTimeout(cancelPromptTimer);
        if (cancelPromptInterval !== null) clearInterval(cancelPromptInterval);
        if (lease) {
          try {
            if (releaseConfirmed) {
              runToast(dismissMicrophoneSafetyToast(lease.ownerId));
            }
            runToast(
              dismissToastForAction("cancel_recording_stop", lease.ownerId),
            );
          } catch {
            getLogger().warning(
              "Could not dismiss the recording cancel prompt",
            );
          }
        }
      }

      return { audio, context };
    },
    [intl, nativeStartOwnerRef, sendPhaseToPill],
  );

  const processFinalizedRecording = useCallback(
    ({
      audio,
      a11yInfo,
      appTarget,
      toneId,
      rawTranscript,
      transcribeResult,
      isCurrent,
    }: FinalizedRecording): Promise<RawStopResp> => {
      const session = sessionRef.current;
      const strategy = strategyRef.current;
      const trace = pipelineTraceRef.current;
      if (!session || !strategy) {
        getLogger().warning(
          `stopRecordingRaw: refs cleared (session=${!!session}, strategy=${!!strategy})`,
        );
        return Promise.resolve({ shouldContinue: false });
      }

      const persistReviewedTranscript = createReviewedTranscriptPersistence({
        audio,
        rawTranscript: rawTranscript ?? null,
        transcribeResult,
        trace,
        store: storeTranscription,
        surface: surfacePersistedReviewInHistory,
        showToast,
        formatFailure: () =>
          formatReviewPersistenceFailure(
            intl.formatMessage,
            getAppState().userPrefs?.incognitoModeEnabled === true,
          ),
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
        trace,
        isCurrent,
      });
    },
    [sendPhaseToPill],
  );

  const finalizeAndPostProcess = useCallback(
    async ({
      audio,
      context,
      isCurrent = () => true,
    }: {
      audio: StopRecordingResponse;
      context: Promise<StopContext>;
      isCurrent?: () => boolean;
    }): Promise<RawStopResp> => {
      getLogger().info("Finalizing transcription session");
      const session = sessionRef.current;
      const strategy = strategyRef.current;
      const ownsFinalization = () =>
        isCurrent() &&
        sessionRef.current === session &&
        strategyRef.current === strategy;
      if (!session || !strategy || !ownsFinalization()) {
        releaseStopContext(context);
        return { shouldContinue: false };
      }
      if (audio.captureFailed) {
        releaseStopContext(context);
        // A partial capture is useful for recovery, but must not be finalized
        // or presented as complete. Live providers may already have its prefix.
        cleanupSessionQuietly(session);
        if (!ownsFinalization()) return { shouldContinue: false };
        markFinalizedTranscription(pipelineTraceRef.current);
        await handleEmptyTranscriptionResult({
          audio,
          transcribeResult: failedCaptureResult(),
          strategy,
          formatMessage: intl.formatMessage,
          showToast,
          storeTranscriptionFn: storeTranscription,
          refreshMember,
          isCurrent: ownsFinalization,
        });
        return { shouldContinue: false };
      }
      const toneSnapshot = utteranceTonesRef.current.read();
      if (!ownsFinalization()) {
        releaseStopContext(context);
        return { shouldContinue: false };
      }
      // Start transcription before context work, and convert exceptions or a
      // deadline into the existing failed-transcription audio recovery path.
      const transcription = finalizeSessionWithDeadline(session, audio);

      const contextAtStop = await context.catch(() => ({
        a11yInfo: null,
        appTarget: null,
      }));
      if (!ownsFinalization()) return { shouldContinue: false };
      const { a11yInfo, appTarget, toneId } = await prepareFinalizationContext(
        Promise.resolve(contextAtStop),
        () => toneSnapshot,
        ownsFinalization,
      );
      const transcribeResult = await transcription;
      if (!ownsFinalization()) return { shouldContinue: false };
      markFinalizedTranscription(pipelineTraceRef.current);
      const rawTranscript = transcribeResult?.rawTranscript;
      logFinalizationSummary(rawTranscript, toneId, appTarget);

      if (!transcribeResult.rawTranscript) {
        await handleEmptyTranscriptionResult({
          audio,
          transcribeResult,
          strategy,
          formatMessage: intl.formatMessage,
          showToast,
          storeTranscriptionFn: storeTranscription,
          refreshMember,
          isCurrent: ownsFinalization,
        });
        getLogger().warning("stopRecordingRaw: no rawTranscript from finalize");
        return { shouldContinue: false };
      }

      return processFinalizedRecording({
        audio,
        a11yInfo,
        appTarget,
        toneId,
        rawTranscript: transcribeResult.rawTranscript,
        transcribeResult,
        isCurrent: ownsFinalization,
      });
    },
    [processFinalizedRecording],
  );

  return { captureStopRecordingInfo, finalizeAndPostProcess };
}
