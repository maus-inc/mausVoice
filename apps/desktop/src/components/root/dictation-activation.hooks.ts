import { useCallback } from "react";
import type { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState } from "../../store";
import {
  trackAgentStart,
  trackDictationStart,
} from "../../utils/analytics.utils";
import { playAlertSound } from "../../utils/audio.utils";
import { getLogger } from "../../utils/log.utils";
import { getIsDictationUnlocked } from "../../utils/user.utils";

/** Gate user-visible recording activations against unlock and pending review state. */
export function useRecordingActivation(
  startRecording: (args: {
    mode: RecordingMode;
    language?: string | null;
    onNativeStartDispatched?: (operation: number) => void;
    deactivation?: AbortSignal;
  }) => Promise<number | undefined>,
  stopRecording: (expectedOperation?: number) => Promise<void>,
) {
  const startDictationRecording = useCallback(
    async (
      onNativeStartDispatched?: (operation: number) => void,
      deactivation?: AbortSignal,
    ) => {
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

      return await startRecording({
        mode: "dictate",
        ...(onNativeStartDispatched ? { onNativeStartDispatched } : {}),
        ...(deactivation ? { deactivation } : {}),
      });
    },
    [startRecording],
  );

  const stopDictationRecording = useCallback(
    async (expectedOperation?: number) => {
      getLogger().info("Stopping dictation recording");
      await stopRecording(expectedOperation);
    },
    [stopRecording],
  );

  const startAgentRecording = useCallback(
    async (
      onNativeStartDispatched?: (operation: number) => void,
      deactivation?: AbortSignal,
    ) => {
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
      return await startRecording({
        mode: "agent",
        ...(onNativeStartDispatched ? { onNativeStartDispatched } : {}),
        ...(deactivation ? { deactivation } : {}),
      });
    },
    [startRecording],
  );

  const stopAgentRecording = useCallback(
    async (expectedOperation?: number) => {
      getLogger().info("Stopping agent recording");
      await stopRecording(expectedOperation);
    },
    [stopRecording],
  );

  return {
    startDictationRecording,
    stopDictationRecording,
    startAgentRecording,
    stopAgentRecording,
  };
}
