import { useDictationLifecycle } from "./dictation-lifecycle.hooks";
import { useDictationTimers } from "./dictation-timers.hooks";
import { useDictationWindowState } from "./dictation-window-state.hooks";
import { useRecordingControllers } from "./dictation-controllers.hooks";
import { usePillPhaseSync } from "./dictation-phase.hooks";
import { useDictationBacklogDrain } from "./dictation-backlog.hooks";

/** Compose the lifetime-owned state shared by recording and native controls. */
export function useDictationEnvironment(isMainWindow: boolean) {
  const lifecycle = useDictationLifecycle();
  const timers = useDictationTimers();
  const windowState = useDictationWindowState();
  const controllers = useRecordingControllers(
    windowState.additionalLanguageEntries,
  );
  const sendPhaseToPill = usePillPhaseSync(isMainWindow);
  useDictationBacklogDrain(
    isMainWindow,
    windowState.isActiveSession,
    lifecycle.strategyRef,
    lifecycle.recordingOperationRef,
    lifecycle.recordingSessionRef,
  );
  return {
    ...lifecycle,
    ...timers,
    ...windowState,
    ...controllers,
    sendPhaseToPill,
  };
}
