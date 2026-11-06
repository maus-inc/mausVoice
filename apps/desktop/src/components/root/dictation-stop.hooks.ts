import type { UnlistenFn } from "@tauri-apps/api/event";
import { delayed } from "@maus-inc/utilities";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { recordStreak } from "../../actions/user.actions";
import { getAppState } from "../../store";
import type { OverlayPhase } from "../../types/overlay.types";
import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { getLogger } from "../../utils/log.utils";
import { startAsPromise } from "../../utils/promise.utils";
import { sendPhaseWithoutWaiting } from "../../utils/phase-delivery.utils";
import { sendPillStageText } from "../../utils/overlay.utils";
import {
  markPipeline,
  startPipelineTrace,
  type PipelineTrace,
} from "../../utils/pipeline-trace";
import { getToneIdToUse } from "../../utils/tone.utils";
import { getIsOnboarded } from "../../utils/user.utils";
import { captureUserSession } from "../../utils/user-session.utils";
import type { StopContext } from "./dictation-finalize-context";
import type { RawStopResp } from "./dictation-finalization.types";
import type { SystemVolumeDim } from "./dictation-volume-dim";

type StopState = ReturnType<typeof getAppState>;

/**
 * Schedule the streak update for the account that stopped recording. A late
 * update for a retired operation or a replaced session is dropped rather than
 * attributed to whoever is recording now.
 */
const scheduleStreakOnStop = (
  stateAtStop: StopState,
  operation: number,
  recordingOperationRef: { current: number },
  recordingSessionRef: { current: (() => boolean) | null } | undefined,
): void => {
  try {
    if (recordingOperationRef.current !== operation) return;
    if (!getIsOnboarded(stateAtStop)) return;
    if (!(recordingSessionRef?.current?.() ?? true)) return;
    const userId = stateAtStop.auth?.uid ?? null;
    const authSessionNonce = stateAtStop.authSessionNonce;
    const isCurrentUser = () => {
      const state = getAppState();
      return (
        (state.auth?.uid ?? null) === userId &&
        state.authSessionNonce === authSessionNonce
      );
    };
    delayed(2000)
      .then(() => recordStreak(isCurrentUser))
      .catch((error: unknown) =>
        getLogger().error(`Failed to update recording streak: ${error}`),
      );
  } catch {
    getLogger().warning("Could not schedule the recording streak");
  }
};

/** Diagnostics and presentation must not prevent the stop from reaching the microphone. */
const publishStopPresentation = ({
  operation,
  recordingOperationRef,
  pipelineTraceRef,
  intl,
}: {
  operation: number;
  recordingOperationRef: { current: number };
  pipelineTraceRef: { current: PipelineTrace | null };
  intl: ReturnType<typeof useIntl>;
}): void => {
  try {
    if (recordingOperationRef.current !== operation) return;
    pipelineTraceRef.current = startPipelineTrace();
    markPipeline(pipelineTraceRef.current, "stopped");
    if (recordingOperationRef.current !== operation) return;
    sendPillStageText(
      intl.formatMessage({ defaultMessage: "Finalizing audio" }),
    );
  } catch {
    getLogger().warning("Could not update recording stop presentation");
  }
};

/**
 * Capture the live tone at stop: this is the style the whole utterance is
 * finalized with, so a mid-dictation style switch restyles the entire
 * transcript (and, being persisted, starts the next recording too).
 */
const snapshotStopTone = ({
  stateAtStop,
  operation,
  recordingOperationRef,
  utteranceTonesRef,
}: {
  stateAtStop: StopState;
  operation: number;
  recordingOperationRef: { current: number };
  utteranceTonesRef: {
    current: { snapshotAtStop: (tone: string | null) => void };
  };
}): void => {
  try {
    if (recordingOperationRef.current !== operation) return;
    utteranceTonesRef.current.snapshotAtStop(
      getToneIdToUse(stateAtStop, { currentAppToneId: null }),
    );
  } catch {
    getLogger().warning("Could not snapshot the recording style at stop");
  }
};

/**
 * Retire the operation token, then release the state that belongs to it. A
 * successor installed while an IPC was in flight keeps its own timers, hotkeys
 * and tone snapshots.
 */
const retireStoppedOperation = ({
  operation,
  recordingOperationRef,
  clearRecordingTimers,
  hardResetHotkeyState,
  clearUtteranceToneSnapshots,
}: {
  operation: number;
  recordingOperationRef: { current: number };
  clearRecordingTimers: () => void;
  hardResetHotkeyState: () => void;
  clearUtteranceToneSnapshots: () => void;
}): void => {
  if (recordingOperationRef.current !== operation) return;
  const retiredOperation = ++recordingOperationRef.current;
  try {
    clearRecordingTimers();
  } catch {
    getLogger().warning("Could not clear recording timers after stop");
  }
  try {
    if (recordingOperationRef.current === retiredOperation)
      hardResetHotkeyState();
  } catch {
    getLogger().warning("Could not reset recording hotkeys after stop");
  }
  try {
    if (recordingOperationRef.current === retiredOperation)
      clearUtteranceToneSnapshots();
  } catch {
    getLogger().warning("Could not clear recording style after stop");
  }
};

/**
 * Dispatch the owned capture stop. A synchronous transport failure becomes a
 * rejection so the caller's single `try` still sees it.
 */
const beginCaptureStop = (
  captureStopRecordingInfo: (isCurrent?: () => boolean) => Promise<{
    audio: StopRecordingResponse | null;
    context: Promise<StopContext>;
  }>,
  isCurrent: () => boolean,
): ReturnType<typeof captureStopRecordingInfo> => {
  // A synchronous transport failure must reach the same caller as a rejected
  // stop, and both are observed here rather than left unhandled.
  const capture = startAsPromise(() => captureStopRecordingInfo(isCurrent));
  void capture.catch(() => undefined);
  return capture;
};

/**
 * Retire the two things a stop makes irrelevant. The dim ends here rather than
 * after transcription: a dim this recording started can still be in flight, and
 * a stop landing between its read and its write has nothing to put back.
 */
const retireStopTriggers = ({
  operation,
  recordingOperationRef,
  clearRecordingTimers,
  systemVolumeDim,
}: {
  operation: number;
  recordingOperationRef: { current: number };
  clearRecordingTimers: () => void;
  systemVolumeDim: Pick<SystemVolumeDim, "endRecording">;
}): void => {
  try {
    if (recordingOperationRef.current === operation) clearRecordingTimers();
  } catch {
    getLogger().warning("Could not clear recording timers during stop");
  }
  try {
    if (recordingOperationRef.current === operation)
      systemVolumeDim.endRecording();
  } catch {
    getLogger().warning("Could not restore the system volume during stop");
  }
};

/** Every stop path returns the pill to idle and releases its audio listener. */
const releaseStopResources = ({
  ownedAudioChunkUnlisten,
  operation,
  recordingOperationRef,
  releaseAudioIntake,
  sendPhaseToPill,
}: {
  ownedAudioChunkUnlisten: UnlistenFn | null;
  operation: number;
  recordingOperationRef: { current: number };
  releaseAudioIntake: (owned?: UnlistenFn | null) => void;
  sendPhaseToPill: (phase: OverlayPhase) => Promise<void>;
}): void => {
  try {
    releaseAudioIntake(ownedAudioChunkUnlisten);
  } catch {
    getLogger().warning("Could not release the recording audio listener");
  }
  if (recordingOperationRef.current === operation)
    sendPhaseWithoutWaiting(sendPhaseToPill, "idle");
};

/** The stop reply that must not replace the microphone-safety guidance with a generic error. */
const noAudioStopResult = (intl: ReturnType<typeof useIntl>): RawStopResp => ({
  shouldContinue: false,
  abortMessage: `${intl.formatMessage({ defaultMessage: "Failed to stop recording" })}. ${intl.formatMessage({ defaultMessage: "The microphone may still be in use. If its indicator stays on, quit the app." })}`,
});

const updateTranscribingStage = (intl: ReturnType<typeof useIntl>): void => {
  try {
    sendPillStageText(intl.formatMessage({ defaultMessage: "Transcribing" }));
  } catch {
    getLogger().warning("Could not update the transcription stage");
  }
};

/** Own the stop pipeline's lock, watchdog cleanup and user-facing state. */
export function useRecordingStop({
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
}: {
  audioChunkUnlistenRef: { current: UnlistenFn | null };
  isStoppingRef: { current: boolean };
  recordingOperationRef: { current: number };
  recordingSessionRef?: { current: (() => boolean) | null };
  pipelineTraceRef: { current: PipelineTrace | null };
  utteranceTonesRef: {
    current: { snapshotAtStop: (tone: string | null) => void };
  };
  captureStopRecordingInfo: (isCurrent?: () => boolean) => Promise<{
    audio: StopRecordingResponse | null;
    context: Promise<StopContext>;
  }>;
  finalizeAndPostProcess: (args: {
    audio: StopRecordingResponse;
    context: Promise<StopContext>;
    isCurrent?: () => boolean;
  }) => Promise<RawStopResp>;
  abortRecording: (message?: {
    title?: string;
    body: unknown;
  }) => Promise<void>;
  clearRecordingTimers: () => void;
  clearUtteranceToneSnapshots: () => void;
  hardResetHotkeyState: () => void;
  releaseAudioIntake: (owned?: UnlistenFn | null) => void;
  sendPhaseToPill: (phase: OverlayPhase) => Promise<void>;
  systemVolumeDim: Pick<SystemVolumeDim, "endRecording">;
}) {
  const intl = useIntl();
  const [isStopping, setIsStopping] = useState(false);
  const stopRecordingRaw = useCallback(async (): Promise<RawStopResp> => {
    const ownedAudioChunkUnlisten = audioChunkUnlistenRef.current;
    const operation = recordingOperationRef.current;
    const isCurrentSession = captureUserSession();
    const isRecordingSession = recordingSessionRef?.current ?? (() => true);
    const isCurrent = () =>
      recordingOperationRef.current === operation &&
      isCurrentSession() &&
      isRecordingSession();
    const capture = beginCaptureStop(captureStopRecordingInfo, isCurrent);
    getLogger().info("Stopping recording");
    retireStopTriggers({
      operation,
      recordingOperationRef,
      clearRecordingTimers,
      systemVolumeDim,
    });

    try {
      const { audio, context } = await capture;
      // Still stop the microphone, but never hand a late reply to a new
      // recording or authentication session.
      if (!isCurrent()) {
        void context.catch(() => undefined);
        return { shouldContinue: false };
      }
      if (!audio) {
        getLogger().warning("stopRecordingRaw: no audio data received");
        // Abort presents its own toast after retiring the operation. Preserve
        // the microphone-safety guidance there rather than replacing it with a
        // generic no-audio error while release may still be unconfirmed.
        return noAudioStopResult(intl);
      }
      updateTranscribingStage(intl);
      if (!isCurrent()) {
        void context.catch(() => undefined);
        return { shouldContinue: false };
      }
      const result = await finalizeAndPostProcess({
        audio,
        context,
        isCurrent,
      });
      return isCurrent() ? result : { shouldContinue: false };
    } catch (error) {
      if (!isCurrent()) return { shouldContinue: false };
      const errorName = error instanceof Error ? ` [name=${error.name}]` : "";
      getLogger().error(`Error during stopRecording: ${error}${errorName}`);
      if (recordingOperationRef.current === operation)
        clearUtteranceToneSnapshots();
      return {
        shouldContinue: false,
        abortMessage: String(error),
      };
    } finally {
      releaseStopResources({
        ownedAudioChunkUnlisten,
        operation,
        recordingOperationRef,
        releaseAudioIntake,
        sendPhaseToPill,
      });
    }
  }, [
    captureStopRecordingInfo,
    clearRecordingTimers,
    clearUtteranceToneSnapshots,
    finalizeAndPostProcess,
    releaseAudioIntake,
    recordingSessionRef,
    sendPhaseToPill,
    systemVolumeDim,
    intl,
  ]);

  const stopRecording = useCallback(
    async (expectedOperation?: number) => {
      if (
        expectedOperation !== undefined &&
        expectedOperation !== recordingOperationRef.current
      )
        return;
      if (isStoppingRef.current) {
        getLogger().info("stopRecording skipped (already stopping)");
        return;
      }

      const operation = recordingOperationRef.current;
      const stateAtStop = getAppState();
      isStoppingRef.current = true;
      // Dispatch the owned audio stop before presentation or other callbacks can
      // retire this operation and replace its listener or native lease.
      const rawStop = stopRecordingRaw().catch((error) => {
        const details =
          error instanceof Error
            ? ` [name=${error.name}, stack=${error.stack}]`
            : "";
        getLogger().error(`Error during stopRecording: ${error}${details}`);
        return { shouldContinue: false, abortMessage: String(error) };
      });
      try {
        scheduleStreakOnStop(
          stateAtStop,
          operation,
          recordingOperationRef,
          recordingSessionRef,
        );
        getLogger().info("stopRecording entered");
        setIsStopping(true);
        publishStopPresentation({
          operation,
          recordingOperationRef,
          pipelineTraceRef,
          intl,
        });
        snapshotStopTone({
          stateAtStop,
          operation,
          recordingOperationRef,
          utteranceTonesRef,
        });
        const res = await rawStop;

        getLogger().info(
          `stopRecording result: shouldContinue=${res.shouldContinue}, abortMessage=${res.abortMessage ?? "none"}`,
        );
        if (
          !res.shouldContinue &&
          recordingOperationRef.current === operation
        ) {
          await abortRecording(
            res.abortMessage ? { body: res.abortMessage } : undefined,
          );
        }
      } finally {
        // Invalidate the operation token so an in-flight start tail can never arm
        // timers for this recording now that it has ended. The dim is not guarded
        // by this token: it retired at the top of `stopRecordingRaw`, where a stop
        // becomes a stop rather than waiting for transcription first.
        retireStoppedOperation({
          operation,
          recordingOperationRef,
          clearRecordingTimers,
          hardResetHotkeyState,
          clearUtteranceToneSnapshots,
        });
        isStoppingRef.current = false;
        setIsStopping(false);
      }
    },
    [
      abortRecording,
      clearRecordingTimers,
      clearUtteranceToneSnapshots,
      hardResetHotkeyState,
      pipelineTraceRef,
      recordingSessionRef,
      sendPhaseToPill,
      stopRecordingRaw,
      setIsStopping,
      utteranceTonesRef,
      intl,
    ],
  );

  return { isStopping, stopRecording };
}
