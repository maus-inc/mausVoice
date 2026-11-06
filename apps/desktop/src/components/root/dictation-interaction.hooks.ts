import {
  useRecordingControllerBindings,
  type RecordingHandlers,
} from "./dictation-controllers.hooks";
import { usePillPresentationSync } from "./dictation-pill-presentation.hooks";
import { useDictationHotkeys } from "./dictation-hotkeys.hooks";
import { useDictationAssistant } from "./dictation-assistant.hooks";
import { useDictationPause, type PauseOwner } from "./dictation-pause.hooks";
import { useDictationPillEvents } from "./dictation-pill-events.hooks";

/** Connect one recording owner to native pill, hotkey and assistant surfaces. */
export function useDictationInteraction(
  owner: Parameters<typeof useDictationHotkeys>[0] &
    Parameters<typeof useDictationAssistant>[0] &
    Omit<PauseOwner, "operationRef"> & {
      handlersRef: Parameters<typeof useRecordingControllerBindings>[0];
      startDictationRecording: RecordingHandlers["startDictationRecording"];
      stopDictationRecording: RecordingHandlers["stopDictationRecording"];
      startAgentRecording: RecordingHandlers["startAgentRecording"];
      stopAgentRecording: RecordingHandlers["stopAgentRecording"];
      startRecording: Parameters<
        typeof useRecordingControllerBindings
      >[1]["startRecording"];
      stopRecording: RecordingHandlers["stopRecording"];
    },
): void {
  const {
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
  } = owner;
  useRecordingControllerBindings(handlersRef, {
    startDictationRecording,
    stopDictationRecording,
    startAgentRecording,
    stopAgentRecording,
    startRecording,
    stopRecording,
  } satisfies RecordingHandlers);
  usePillPresentationSync(isMainWindow);
  useDictationHotkeys({
    isMainWindow,
    isDictationInteractable,
    isDictationUnlocked,
    dictationController,
    agentController,
    additionalLanguageControllers,
    promptCancelTranscription,
  });
  useDictationAssistant({
    isMainWindow,
    abortRecording,
    enterTypeMode,
    recordingOperationRef,
  });
  const { pauseDictation, resumeDictation } = useDictationPause({
    sessionRef,
    strategyRef,
    operationRef: recordingOperationRef,
    isPausedRef,
    isStoppingRef,
    nativeStartOwnerRef,
    clearUserRecordingTimers,
    startUserRecordingTimers,
  });
  useDictationPillEvents({
    isMainWindow,
    isDictationInteractable,
    isPausedRef,
    isStoppingRef,
    nativeStartOwnerRef,
    abortRecording,
    pauseDictation,
    resumeDictation,
    dictationController,
    agentController,
  });
}
