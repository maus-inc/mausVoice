import { expect, it, vi } from "vitest";
import type { ActivationController } from "../../utils/activation.utils";
const mocks = vi.hoisted(() => ({
  bindings: vi.fn(),
  presentation: vi.fn(),
  hotkeys: vi.fn(),
  assistant: vi.fn(),
  pause: vi.fn(),
  events: vi.fn(),
}));
vi.mock("./dictation-controllers.hooks", () => ({
  useRecordingControllerBindings: mocks.bindings,
}));
vi.mock("./dictation-pill-presentation.hooks", () => ({
  usePillPresentationSync: mocks.presentation,
}));
vi.mock("./dictation-hotkeys.hooks", () => ({
  useDictationHotkeys: mocks.hotkeys,
}));
vi.mock("./dictation-assistant.hooks", () => ({
  useDictationAssistant: mocks.assistant,
}));
vi.mock("./dictation-pause.hooks", () => ({ useDictationPause: mocks.pause }));
vi.mock("./dictation-pill-events.hooks", () => ({
  useDictationPillEvents: mocks.events,
}));
import { useDictationInteraction } from "./dictation-interaction.hooks";

it("shares the same owner callbacks and pause state across native interactions", () => {
  const pauseDictation = vi.fn().mockResolvedValue(undefined);
  const resumeDictation = vi.fn().mockResolvedValue(undefined);
  mocks.pause.mockReturnValue({ pauseDictation, resumeDictation });
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue(undefined);
  const isPausedRef = { current: false };
  const recordingOperationRef = { current: 1 };
  const dictationController = {} as ActivationController;
  const agentController = {} as ActivationController;
  useDictationInteraction({
    isMainWindow: true,
    isDictationInteractable: true,
    isDictationUnlocked: true,
    handlersRef: { current: null },
    dictationController,
    agentController,
    additionalLanguageControllers: [],
    startDictationRecording: start,
    stopDictationRecording: stop,
    startAgentRecording: start,
    stopAgentRecording: stop,
    startRecording: start,
    stopRecording: stop,
    abortRecording: abort,
    promptCancelTranscription: vi.fn(),
    enterTypeMode: vi.fn(),
    sessionRef: { current: null },
    strategyRef: { current: null },
    recordingOperationRef,
    isPausedRef,
    isStoppingRef: { current: false },
    nativeStartOwnerRef: { current: null },
    clearUserRecordingTimers: vi.fn(),
    startUserRecordingTimers: vi.fn(),
  });
  expect(mocks.presentation).toHaveBeenCalledWith(true);
  expect(mocks.bindings).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ startRecording: start, stopRecording: stop }),
  );
  expect(mocks.assistant).toHaveBeenCalledWith(
    expect.objectContaining({ abortRecording: abort, recordingOperationRef }),
  );
  expect(mocks.events).toHaveBeenCalledWith(
    expect.objectContaining({
      dictationController,
      agentController,
      isPausedRef,
      pauseDictation,
      resumeDictation,
    }),
  );
});
