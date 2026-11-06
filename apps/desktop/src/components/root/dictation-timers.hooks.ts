import { useCallback, useEffect, useRef } from "react";
import { clearOwnedTimer } from "./dictation-timers";

type TimerHandle = ReturnType<typeof setTimeout>;

/** Own recording and cancel-prompt timers for the component's lifetime. */
export function useDictationTimers() {
  const recordingWarningTimerRef = useRef<TimerHandle | null>(null);
  const recordingAutoStopTimerRef = useRef<TimerHandle | null>(null);
  const providerWarningTimerRef = useRef<TimerHandle | null>(null);
  const providerAutoStopTimerRef = useRef<TimerHandle | null>(null);
  const cancelPromptTimerRef = useRef<TimerHandle | null>(null);

  const clearUserRecordingTimers = useCallback(() => {
    clearOwnedTimer(recordingWarningTimerRef);
    clearOwnedTimer(recordingAutoStopTimerRef);
  }, []);
  const clearProviderRecordingTimers = useCallback(() => {
    clearOwnedTimer(providerWarningTimerRef);
    clearOwnedTimer(providerAutoStopTimerRef);
  }, []);
  const clearRecordingTimers = useCallback(() => {
    clearUserRecordingTimers();
    clearProviderRecordingTimers();
  }, [clearUserRecordingTimers, clearProviderRecordingTimers]);
  const clearCancelPromptTimer = useCallback(() => {
    clearOwnedTimer(cancelPromptTimerRef);
  }, []);
  useEffect(
    () => () => {
      clearRecordingTimers();
      clearCancelPromptTimer();
    },
    [clearRecordingTimers, clearCancelPromptTimer],
  );

  return {
    recordingWarningTimerRef,
    recordingAutoStopTimerRef,
    providerWarningTimerRef,
    providerAutoStopTimerRef,
    cancelPromptTimerRef,
    clearUserRecordingTimers,
    clearProviderRecordingTimers,
    clearRecordingTimers,
    clearCancelPromptTimer,
  };
}
