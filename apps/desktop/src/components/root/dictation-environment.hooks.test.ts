import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  timers: vi.fn(),
  state: vi.fn(),
  controllers: vi.fn(),
  phase: vi.fn(),
  backlog: vi.fn(),
}));
vi.mock("./dictation-lifecycle.hooks", () => ({
  useDictationLifecycle: mocks.lifecycle,
}));
vi.mock("./dictation-timers.hooks", () => ({
  useDictationTimers: mocks.timers,
}));
vi.mock("./dictation-window-state.hooks", () => ({
  useDictationWindowState: mocks.state,
}));
vi.mock("./dictation-controllers.hooks", () => ({
  useRecordingControllers: mocks.controllers,
}));
vi.mock("./dictation-phase.hooks", () => ({ usePillPhaseSync: mocks.phase }));
vi.mock("./dictation-backlog.hooks", () => ({
  useDictationBacklogDrain: mocks.backlog,
}));
import { useDictationEnvironment } from "./dictation-environment.hooks";
it("shares the recording owner with timers, controllers, phase and backlog", () => {
  const strategyRef = { current: null };
  const recordingOperationRef = { current: 0 };
  const recordingSessionRef = {
    current: (() => true) as (() => boolean) | null,
  };
  const entries = [{ actionName: "fr", language: "fr" }];
  const sendPhase = vi.fn();
  mocks.lifecycle.mockReturnValue({
    strategyRef,
    recordingOperationRef,
    recordingSessionRef,
  });
  mocks.timers.mockReturnValue({ clearRecordingTimers: vi.fn() });
  mocks.state.mockReturnValue({
    additionalLanguageEntries: entries,
    isActiveSession: true,
  });
  mocks.controllers.mockReturnValue({ dictationController: {} });
  mocks.phase.mockReturnValue(sendPhase);
  const result = useDictationEnvironment(true);
  expect(mocks.controllers).toHaveBeenCalledWith(entries);
  expect(mocks.backlog).toHaveBeenCalledWith(
    true,
    true,
    strategyRef,
    recordingOperationRef,
    recordingSessionRef,
  );
  expect(result).toMatchObject({
    strategyRef,
    recordingOperationRef,
    sendPhaseToPill: sendPhase,
  });
});
