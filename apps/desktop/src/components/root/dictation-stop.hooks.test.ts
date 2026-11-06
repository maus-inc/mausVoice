import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
  setStopping: vi.fn(),
  mark: vi.fn(),
  onboarded: false,
  streak: vi.fn((_isCurrent: () => boolean) => Promise.resolve()),
  delay: vi.fn(() => Promise.resolve()),
  state: { auth: null as { uid: string } | null, authSessionNonce: 0 },
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useState: () => [false, mocks.setStopping],
}));
vi.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock("@maus-inc/utilities", () => ({ delayed: mocks.delay }));
vi.mock("../../actions/user.actions", () => ({ recordStreak: mocks.streak }));
vi.mock("../../store", () => ({ getAppState: () => mocks.state }));
vi.mock("../../utils/user.utils", () => ({
  getIsOnboarded: () => mocks.onboarded,
}));
vi.mock("../../utils/tone.utils", () => ({
  getToneIdToUse: vi.fn(() => "tone"),
}));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("../../utils/overlay.utils", () => ({ sendPillStageText: vi.fn() }));
vi.mock("../../utils/pipeline-trace", () => ({
  startPipelineTrace: () => ({}),
  markPipeline: mocks.mark,
}));
import { sendPillStageText } from "../../utils/overlay.utils";
import { getToneIdToUse } from "../../utils/tone.utils";
import { useRecordingStop } from "./dictation-stop.hooks";

it("releases the owned listener and aborts when capture yields no audio", async () => {
  const unlisten = vi.fn();
  const refs = {
    audioChunkUnlistenRef: { current: unlisten },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 4 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
  };
  const capture = vi.fn().mockResolvedValue({
    audio: null,
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  const abort = vi.fn().mockResolvedValue(undefined);
  const clearTimers = vi.fn();
  const clearTones = vi.fn();
  const reset = vi.fn();
  const release = vi.fn();
  const send = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn();
  const engine = useRecordingStop({
    ...refs,
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: vi.fn(),
    abortRecording: abort,
    clearRecordingTimers: clearTimers,
    clearUtteranceToneSnapshots: clearTones,
    hardResetHotkeyState: reset,
    releaseAudioIntake: release,
    sendPhaseToPill: send,
    systemVolumeDim: { endRecording: end },
  });
  await engine.stopRecording();
  expect(end).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith(unlisten);
  expect(send).toHaveBeenCalledWith("idle");
  expect(abort).toHaveBeenCalledWith({
    body: "Failed to stop recording. The microphone may still be in use. If its indicator stays on, quit the app.",
  });
  expect(refs.recordingOperationRef.current).toBe(5);
  expect(refs.isStoppingRef.current).toBe(false);
  expect(reset).toHaveBeenCalledOnce();
  expect(clearTones).toHaveBeenCalledOnce();
});

it("claims the stop and old listener before presentation can replace the operation", async () => {
  const operation = { current: 4 };
  const oldListener = vi.fn();
  const newListener = vi.fn();
  const listener = { current: oldListener };
  const capture = vi.fn().mockResolvedValue({
    audio: { samples: [0.5], sampleRate: 16000 },
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  const release = vi.fn();
  const finalize = vi.fn();
  const clearTimers = vi.fn();
  const reset = vi.fn();
  vi.mocked(sendPillStageText).mockImplementationOnce(() => {
    operation.current = 5;
    listener.current = newListener;
  });
  const engine = useRecordingStop({
    audioChunkUnlistenRef: listener,
    isStoppingRef: { current: false },
    recordingOperationRef: operation,
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: finalize,
    abortRecording: vi.fn(),
    clearRecordingTimers: clearTimers,
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: reset,
    releaseAudioIntake: release,
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  await engine.stopRecording();
  expect(capture).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledExactlyOnceWith(oldListener);
  expect(finalize).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(operation.current).toBe(5);
});

it("uses the style state captured at release even if stop dispatch changes state", async () => {
  const originalState = mocks.state;
  vi.mocked(getToneIdToUse).mockClear();
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 1 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: vi.fn(() => {
      mocks.state = { ...originalState };
      return Promise.resolve({
        audio: { samples: [0.5], sampleRate: 16000 },
        context: Promise.resolve({ a11yInfo: null, appTarget: null }),
      });
    }),
    finalizeAndPostProcess: vi.fn().mockResolvedValue({ shouldContinue: true }),
    abortRecording: vi.fn(),
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  try {
    await engine.stopRecording();
    expect(vi.mocked(getToneIdToUse).mock.calls[0][0]).toBe(originalState);
  } finally {
    mocks.state = originalState;
  }
});

it("does not finalize a recording whose auth session retired before stop", async () => {
  const finalize = vi.fn().mockResolvedValue({ shouldContinue: true });
  const abort = vi.fn().mockResolvedValue(undefined);
  const capture = vi.fn().mockResolvedValue({
    audio: { samples: [0.5], sampleRate: 16000 },
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 4 },
    recordingSessionRef: { current: () => false },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: finalize,
    abortRecording: abort,
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  mocks.onboarded = true;
  mocks.streak.mockClear();
  await engine.stopRecording();
  expect(capture).toHaveBeenCalledOnce(); // The microphone still gets stopped.
  expect(finalize).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledWith(undefined);
  expect(mocks.streak).not.toHaveBeenCalled();
  mocks.onboarded = false;
});

it("does not finalize audio into a new auth session", async () => {
  let finish!: (value: {
    audio: { samples: number[]; sampleRate: number };
    context: Promise<{ a11yInfo: null; appTarget: null }>;
  }) => void;
  const capture = vi.fn(
    () =>
      new Promise<{
        audio: { samples: number[]; sampleRate: number };
        context: Promise<{ a11yInfo: null; appTarget: null }>;
      }>((resolve) => {
        finish = resolve;
      }),
  );
  const finalize = vi.fn().mockResolvedValue({ shouldContinue: true });
  const abort = vi.fn().mockResolvedValue(undefined);
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 4 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: finalize,
    abortRecording: abort,
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  mocks.state.authSessionNonce = 0;
  const pending = engine.stopRecording();
  mocks.state.authSessionNonce = 1;
  finish({
    audio: { samples: [0.5], sampleRate: 16000 },
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  await pending;
  expect(finalize).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledWith(undefined);
  mocks.state.authSessionNonce = 0;
});

it("does not reset or abort a successor when an old stop completes late", async () => {
  let finish!: (result: {
    audio: null;
    context: Promise<{ a11yInfo: null; appTarget: null }>;
  }) => void;
  const capture = vi.fn(
    () =>
      new Promise<{
        audio: null;
        context: Promise<{ a11yInfo: null; appTarget: null }>;
      }>((resolve) => {
        finish = resolve;
      }),
  );
  const operation = { current: 7 };
  const clearTimers = vi.fn();
  const clearTones = vi.fn();
  const reset = vi.fn();
  const abort = vi.fn();
  const send = vi.fn().mockResolvedValue(undefined);
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: operation,
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: vi.fn(),
    abortRecording: abort,
    clearRecordingTimers: clearTimers,
    clearUtteranceToneSnapshots: clearTones,
    hardResetHotkeyState: reset,
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: send,
    systemVolumeDim: { endRecording: vi.fn() },
  });
  const stop = engine.stopRecording();
  operation.current = 8;
  finish({
    audio: null,
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  await stop;
  expect(operation.current).toBe(8);
  expect(abort).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(clearTones).not.toHaveBeenCalled();
  expect(clearTimers).toHaveBeenCalledOnce();
});

it("stops cleanup when clearing old timers installs a successor", async () => {
  const operation = { current: 1 };
  const reset = vi.fn();
  const clearTones = vi.fn();
  const clearTimers = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      operation.current = 3;
    });
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: operation,
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: vi.fn().mockResolvedValue({
      audio: { samples: [0.5], sampleRate: 16000 },
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
    finalizeAndPostProcess: vi.fn().mockResolvedValue({ shouldContinue: true }),
    abortRecording: vi.fn(),
    clearRecordingTimers: clearTimers,
    clearUtteranceToneSnapshots: clearTones,
    hardResetHotkeyState: reset,
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  await engine.stopRecording();
  expect(operation.current).toBe(3);
  expect(reset).not.toHaveBeenCalled();
  expect(clearTones).not.toHaveBeenCalled();
});

it("never passes late old audio to a replacement session", async () => {
  vi.mocked(sendPillStageText).mockClear();
  let finish!: (value: {
    audio: { samples: number[]; sampleRate: number };
    context: Promise<{ a11yInfo: null; appTarget: null }>;
  }) => void;
  const operation = { current: 1 };
  const finalize = vi.fn();
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: operation,
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    finalizeAndPostProcess: finalize,
    abortRecording: vi.fn(),
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn(),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  const stopping = engine.stopRecording();
  operation.current = 2;
  finish({
    audio: { samples: [0.5], sampleRate: 16000 },
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  await stopping;
  expect(finalize).not.toHaveBeenCalled();
  // Only the initial "Finalizing audio" stage was sent.
  expect(sendPillStageText).toHaveBeenCalledOnce();
});

it("observes a rejected delayed streak update", async () => {
  mocks.onboarded = true;
  mocks.streak.mockRejectedValueOnce(new Error("streak failed"));
  mocks.logger.error.mockClear();
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 1 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: vi.fn().mockResolvedValue({
      audio: null,
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
    finalizeAndPostProcess: vi.fn(),
    abortRecording: vi.fn().mockResolvedValue(undefined),
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  await engine.stopRecording();
  await vi.waitFor(() =>
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("streak failed"),
    ),
  );
  mocks.onboarded = false;
});

it("ignores a release from an activation that no longer owns the recording", async () => {
  const capture = vi.fn();
  const timers = vi.fn();
  const end = vi.fn();
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 20 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: vi.fn(),
    abortRecording: vi.fn(),
    clearRecordingTimers: timers,
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn(),
    systemVolumeDim: { endRecording: end },
  });
  await engine.stopRecording(10);
  expect(capture).not.toHaveBeenCalled();
  expect(timers).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it("stops and finalizes audio even when auxiliary stop and cleanup helpers throw", async () => {
  mocks.mark.mockImplementationOnce(() => {
    throw new Error("trace failure");
  });
  const fail = vi.fn(() => {
    throw new Error("auxiliary failure");
  });
  const refs = {
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 1 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: fail } },
  };
  const capture = vi.fn().mockResolvedValue({
    audio: { samples: [0.5], sampleRate: 16000 },
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  const finalize = vi.fn().mockResolvedValue({ shouldContinue: true });
  const abort = vi.fn();
  const send = vi.fn().mockResolvedValue(undefined);
  const engine = useRecordingStop({
    ...refs,
    captureStopRecordingInfo: capture,
    finalizeAndPostProcess: finalize,
    abortRecording: abort,
    clearRecordingTimers: fail,
    clearUtteranceToneSnapshots: fail,
    hardResetHotkeyState: fail,
    releaseAudioIntake: fail,
    sendPhaseToPill: send,
    systemVolumeDim: { endRecording: fail },
  });
  await engine.stopRecording();
  expect(capture).toHaveBeenCalledOnce();
  expect(finalize).toHaveBeenCalledOnce();
  expect(abort).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith("idle");
  expect(refs.recordingOperationRef.current).toBe(2);
  expect(refs.isStoppingRef.current).toBe(false);
});

it("does not finalize into a successor installed by the transcribing stage", async () => {
  const operation = { current: 1 };
  vi.mocked(sendPillStageText)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      operation.current = 2;
    });
  const finalize = vi.fn();
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: operation,
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: vi.fn().mockResolvedValue({
      audio: { samples: [0.5], sampleRate: 16000 },
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
    finalizeAndPostProcess: finalize,
    abortRecording: vi.fn(),
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  await engine.stopRecording();
  expect(finalize).not.toHaveBeenCalled();
});

it("does not discard captured audio when the transcribing stage update throws", async () => {
  vi.mocked(sendPillStageText)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error("stage failure");
    });
  const finalize = vi.fn().mockResolvedValue({ shouldContinue: true });
  const abort = vi.fn();
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 1 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: vi.fn().mockResolvedValue({
      audio: { samples: [0.5], sampleRate: 16000 },
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
    finalizeAndPostProcess: finalize,
    abortRecording: abort,
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  await engine.stopRecording();
  expect(finalize).toHaveBeenCalledOnce();
  expect(abort).not.toHaveBeenCalled();
});

it("scopes the delayed streak to the account that stopped recording", async () => {
  let release!: () => void;
  mocks.onboarded = true;
  mocks.streak.mockClear();
  mocks.state.auth = { uid: "original" };
  mocks.state.authSessionNonce = 10;
  mocks.delay.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const engine = useRecordingStop({
    audioChunkUnlistenRef: { current: null },
    isStoppingRef: { current: false },
    recordingOperationRef: { current: 1 },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: { current: { snapshotAtStop: vi.fn() } },
    captureStopRecordingInfo: vi.fn().mockResolvedValue({
      audio: null,
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
    finalizeAndPostProcess: vi.fn(),
    abortRecording: vi.fn().mockResolvedValue(undefined),
    clearRecordingTimers: vi.fn(),
    clearUtteranceToneSnapshots: vi.fn(),
    hardResetHotkeyState: vi.fn(),
    releaseAudioIntake: vi.fn(),
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    systemVolumeDim: { endRecording: vi.fn() },
  });
  try {
    await engine.stopRecording();
    mocks.state.authSessionNonce += 1;
    release();
    await Promise.resolve();
    const guard = mocks.streak.mock.calls[0][0];
    expect(guard()).toBe(false);
  } finally {
    mocks.onboarded = false;
    mocks.state.auth = null;
    mocks.state.authSessionNonce = 0;
  }
});
