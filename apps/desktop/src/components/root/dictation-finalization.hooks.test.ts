import { expect, it, vi } from "vitest";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import type { BaseStrategy } from "../../strategies/base.strategy";
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  post: vi.fn(),
  empty: vi.fn(),
  trace: vi.fn(),
  log: vi.fn(),
  logger: {
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    stopwatch: vi.fn(),
  },
}));
vi.mock("react", () => ({ useCallback: (fn: unknown) => fn }));
vi.mock("react-intl", () => ({
  useIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../actions/app-target.actions", () => ({
  tryRegisterCurrentAppTarget: vi.fn(),
}));
vi.mock("../../actions/member.actions", () => ({ refreshMember: vi.fn() }));
vi.mock("../../actions/toast.actions", () => ({
  runToast: vi.fn(),
  showToast: vi.fn(),
  dismissToastForAction: vi.fn(),
  dismissMicrophoneSafetyToast: vi.fn(),
}));
vi.mock("../../actions/transcribe.actions", () => ({
  storeTranscription: vi.fn(),
}));
vi.mock("../../store", () => ({
  getAppState: () => ({ activeRecordingMode: "dictate", userPrefs: {} }),
}));
vi.mock("../../utils/user.utils", () => ({ getMyUserPreferences: () => null }));
vi.mock("../../utils/audio.utils", () => ({ tryPlayAudioChime: vi.fn() }));
vi.mock("../../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("../../utils/recorded-audio.utils", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../utils/recorded-audio.utils")
  >()),
  invokeStopRecording: vi.fn(),
}));
vi.mock("../../utils/pipeline-trace", () => ({
  markFinalizedTranscription: mocks.trace,
}));
vi.mock("./dictation-finalize-context", () => ({
  prepareFinalizationContext: mocks.context,
  logFinalizationSummary: mocks.log,
}));
vi.mock("./dictation-review-persistence", () => ({
  createReviewedTranscriptPersistence: () => vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
import { tryRegisterCurrentAppTarget } from "../../actions/app-target.actions";
import {
  dismissMicrophoneSafetyToast,
  dismissToastForAction,
  showToast,
} from "../../actions/toast.actions";
import { tryPlayAudioChime } from "../../utils/audio.utils";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import { useRecordingFinalization } from "./dictation-finalization.hooks";

it("hands off stopped audio even when the loading phase reply never arrives", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
  const lease = {
    stop: vi.fn().mockResolvedValue(audio),
  } as unknown as NativeRecordingLease;
  const owner = { current: lease as NativeRecordingLease | null };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: owner,
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn(() => new Promise<void>(() => {})),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = await Promise.race([
    engine.captureStopRecordingInfo(),
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), 100),
    ),
  ]);
  expect(result).toMatchObject({ audio });
  expect(owner.current).toBeNull();
});

it("delivers a recovered stop instead of failing dictation", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const audio = { samples: new Float32Array([0.25]), sampleRate: 16000 };
  const waitForStopRecovery = vi.fn().mockResolvedValue(audio);
  const lease = {
    canRecoverStop: true,
    stop: vi.fn().mockRejectedValue(new Error("reply lost")),
    waitForStopRecovery,
  } as unknown as NativeRecordingLease;
  const owner = { current: lease as NativeRecordingLease | null };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: owner,
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const current = () => true;
  const result = await engine.captureStopRecordingInfo(current);
  expect(result.audio).toBe(audio);
  expect(waitForStopRecovery).toHaveBeenCalledWith(5_000, current);
  expect(owner.current).toBeNull();
});

it("warns about an unconfirmed microphone stop without waiting for its reply", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(showToast).mockClear();
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
    mocks.logger.stopwatch.mockImplementation((_name, work) => work());
    let finish!: (audio: { samples: number[]; sampleRate: number }) => void;
    const stop = new Promise<{ samples: number[]; sampleRate: number }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const lease = {
      ownerId: "warning-owner",
      canRecoverStop: true,
      stop: vi.fn(() => stop),
    } as unknown as NativeRecordingLease;
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: { current: lease },
      sessionRef: { current: null },
      strategyRef: { current: null },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    const result = engine.captureStopRecordingInfo();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          "The microphone may still be in use. If its indicator stays on, quit the app.",
        toastType: "error",
        microphoneSafetyOwner: "warning-owner",
      }),
    );
    finish({ samples: [0.5], sampleRate: 16000 });
    expect((await result).audio?.sampleRate).toBe(16000);
    expect(dismissMicrophoneSafetyToast).toHaveBeenCalledWith("warning-owner");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps waiting after a recovery timeout and hands off late audio", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(showToast).mockClear();
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
    mocks.logger.stopwatch.mockImplementation((_name, work) => work());
    const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
    let recover!: (value: typeof audio) => void;
    const late = new Promise<typeof audio>((resolve) => {
      recover = resolve;
    });
    const lease = {
      ownerId: "late-owner",
      canRecoverStop: true,
      stop: vi.fn().mockRejectedValue(new Error("reply lost")),
      waitForStopRecovery: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockReturnValue(late),
      cancel: vi.fn(),
    } as unknown as NativeRecordingLease;
    const owner = { current: lease as NativeRecordingLease | null };
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: owner,
      sessionRef: { current: null },
      strategyRef: { current: null },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    const waiting = engine.captureStopRecordingInfo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lease.waitForStopRecovery).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancel_recording_stop",
        proposalId: "late-owner",
      }),
    );
    expect(lease.cancel).not.toHaveBeenCalled();
    expect(owner.current).toBe(lease);
    recover(audio);
    expect((await waiting).audio).toBe(audio);
    expect(dismissToastForAction).toHaveBeenCalledWith(
      "cancel_recording_stop",
      "late-owner",
    );
    expect(owner.current).toBeNull();
    expect(lease.cancel).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("preserves a real lease when a lost stop recovers after the former timeout", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
    mocks.logger.stopwatch.mockImplementation((_name, work) => work());
    let finish!: (value: unknown) => void;
    const recovery = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let stops = 0;
    const recordingInvoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(31);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording") {
        return ++stops <= 2
          ? Promise.reject(new Error("reply lost"))
          : recovery;
      }
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(recordingInvoke, "late-lease");
    await lease.start(null);
    const owner = { current: lease as NativeRecordingLease | null };
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: owner,
      sessionRef: { current: null },
      strategyRef: { current: null },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    const result = engine.captureStopRecordingInfo();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(owner.current).toBe(lease);
    expect(
      recordingInvoke.mock.calls.some(
        ([command]) =>
          command === "discard_recording" ||
          command === "acknowledge_recording",
      ),
    ).toBe(false);
    finish({ samples: [0.25], sampleRate: 16000 });
    expect(Array.from((await result).audio!.samples)).toEqual([0.25]);
    expect(owner.current).toBeNull();
    expect(recordingInvoke).toHaveBeenCalledWith("acknowledge_recording", {
      ownerId: "late-lease",
      generation: 31,
    });
    expect(
      recordingInvoke.mock.calls.some(
        ([command]) => command === "discard_recording",
      ),
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("never publishes late recovered audio after explicit cancellation", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(dismissMicrophoneSafetyToast).mockClear();
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
    mocks.logger.stopwatch.mockImplementation((_name, work) => work());
    let finish!: (value: unknown) => void;
    const recovery = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    let stops = 0;
    const recordingInvoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(32);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return ++stops <= 2
          ? Promise.reject(new Error("reply lost"))
          : recovery;
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(
      recordingInvoke,
      "cancel-late-lease",
    );
    await lease.start(null);
    const owner = { current: lease as NativeRecordingLease | null };
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: owner,
      sessionRef: { current: null },
      strategyRef: { current: null },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    let current = true;
    const result = engine.captureStopRecordingInfo(() => current);
    await vi.advanceTimersByTimeAsync(10_000);
    current = false;
    owner.current = null;
    await lease.cancel();
    expect((await result).audio).toBeNull();
    expect(dismissToastForAction).toHaveBeenCalledWith(
      "cancel_recording_stop",
      "cancel-late-lease",
    );
    expect(dismissMicrophoneSafetyToast).not.toHaveBeenCalled();
    finish({ samples: [0.25], sampleRate: 16000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recordingInvoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "cancel-late-lease",
      generation: 32,
    });
    expect(
      recordingInvoke.mock.calls.some(
        ([command]) => command === "acknowledge_recording",
      ),
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("stops waiting once the lease can no longer deliver recovered audio", async () => {
  vi.useFakeTimers();
  vi.mocked(showToast).mockClear();
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const lease = {
    // The retained copy expired, so retrying can only spin.
    canRecoverStop: false,
    stop: vi.fn().mockRejectedValue(new Error("reply lost")),
    waitForStopRecovery: vi.fn().mockResolvedValue(null),
  } as unknown as NativeRecordingLease;
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: lease },
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = engine.captureStopRecordingInfo(() => true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(lease.waitForStopRecovery).not.toHaveBeenCalled();
  expect((await result).audio).toBeNull();
  const messages = vi
    .mocked(showToast)
    .mock.calls.map(([options]) => options.message);
  expect(
    messages.some((message) =>
      message.includes("microphone may still be in use"),
    ),
  ).toBe(true);
  vi.useRealTimers();
});

it("keeps the microphone warning while stop recovery has no audio", async () => {
  vi.useFakeTimers();
  vi.mocked(showToast).mockClear();
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const lease = {
    canRecoverStop: true,
    stop: vi.fn().mockRejectedValue(new Error("reply lost")),
    waitForStopRecovery: vi.fn().mockResolvedValue(null),
  } as unknown as NativeRecordingLease;
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: lease },
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  let current = true;
  const result = engine.captureStopRecordingInfo(() => current);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(lease.waitForStopRecovery).toHaveBeenCalled();
  current = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await result).audio).toBeNull();
  const messages = vi
    .mocked(showToast)
    .mock.calls.map(([options]) => options.message);
  expect(messages.length).toBeGreaterThan(0);
  expect(
    messages.every((message) =>
      message.includes("microphone may still be in use"),
    ),
  ).toBe(true);
  vi.useRealTimers();
});

it("does not hand recovered audio to a retired dictation", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  mocks.logger.error.mockClear();
  let release!: () => void;
  const recovery = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = true;
  const lease = {
    canRecoverStop: true,
    stop: vi.fn().mockRejectedValue(new Error("reply lost")),
    waitForStopRecovery: vi.fn(async (_timeout, isCurrent: () => boolean) => {
      await recovery;
      return isCurrent() ? { samples: [0.25], sampleRate: 16000 } : null;
    }),
  } as unknown as NativeRecordingLease;
  const owner = { current: lease as NativeRecordingLease | null };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: owner,
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = engine.captureStopRecordingInfo(() => current);
  await vi.waitFor(() =>
    expect(lease.waitForStopRecovery).toHaveBeenCalledOnce(),
  );
  current = false;
  release();
  expect((await result).audio).toBeNull();
  expect(mocks.logger.error).not.toHaveBeenCalled();
  expect(owner.current).toBe(lease);
});

it("stops the original lease before the stop chime can replace it", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
  const original = {
    stop: vi.fn().mockResolvedValue(audio),
  } as unknown as NativeRecordingLease;
  const successor = { stop: vi.fn() } as unknown as NativeRecordingLease;
  const owner = { current: original as NativeRecordingLease | null };
  vi.mocked(tryPlayAudioChime).mockImplementationOnce(() => {
    owner.current = successor;
  });
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: owner,
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = await engine.captureStopRecordingInfo();
  expect(result.audio).toBe(audio);
  expect(original.stop).toHaveBeenCalledOnce();
  expect(successor.stop).not.toHaveBeenCalled();
  expect(owner.current).toBe(successor);
});

it("bounds stalled focus lookups independently after audio stops", async () => {
  vi.useFakeTimers();
  try {
    const appTarget = { id: "editor", name: "Editor" };
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(
      appTarget as never,
    );
    mocks.logger.stopwatch.mockImplementation((_name, work) => work());
    const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
    const lease = {
      stop: vi.fn().mockResolvedValue(audio),
    } as unknown as NativeRecordingLease;
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: { current: lease },
      sessionRef: { current: null },
      strategyRef: { current: null },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    const { context } = await engine.captureStopRecordingInfo();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(context).resolves.toEqual({ a11yInfo: null, appTarget });
  } finally {
    vi.useRealTimers();
  }
});

it("invalidates an app lookup that outlives its deadline", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(invoke).mockResolvedValue(null);
    vi.mocked(tryRegisterCurrentAppTarget).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    mocks.logger.stopwatch.mockImplementation((_name, work) => work());
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: {
        current: {
          stop: vi.fn().mockResolvedValue({ samples: [], sampleRate: 16000 }),
        } as unknown as NativeRecordingLease,
      },
      sessionRef: { current: null },
      strategyRef: { current: null },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    const { context } = await engine.captureStopRecordingInfo();
    const predicate = vi
      .mocked(tryRegisterCurrentAppTarget)
      .mock.calls.at(-1)?.[0];
    expect(predicate?.()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(context).resolves.toEqual({ a11yInfo: null, appTarget: null });
    expect(predicate?.()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("retires pending app lookup before recovering a failed capture", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  let finishLookup!: () => void;
  let isLookupCurrent: (() => boolean) | undefined;
  vi.mocked(tryRegisterCurrentAppTarget).mockImplementationOnce((current) => {
    isLookupCurrent = current;
    return new Promise((resolve) => {
      finishLookup = () => resolve(null);
    });
  });
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: {
      current: {
        stop: vi.fn().mockResolvedValue({
          samples: [0.5],
          sampleRate: 16000,
          captureFailed: true,
        }),
      } as unknown as NativeRecordingLease,
    },
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const { context } = await engine.captureStopRecordingInfo();
  expect(isLookupCurrent?.()).toBe(false);
  finishLookup();
  await context;
});

it("saves a failed capture prefix without finalizing or uploading it", async () => {
  mocks.empty.mockClear();
  mocks.context.mockClear();
  const session = {
    finalize: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as TranscriptionSession;
  const audio = { samples: [0.5], sampleRate: 16000, captureFailed: true };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: null },
    sessionRef: { current: session },
    strategyRef: { current: {} as BaseStrategy },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  await expect(
    engine.finalizeAndPostProcess({
      audio,
      context: new Promise(() => {}),
    }),
  ).resolves.toEqual({ shouldContinue: false });
  expect(session.cleanup).toHaveBeenCalledOnce();
  expect(session.finalize).not.toHaveBeenCalled();
  expect(mocks.context).not.toHaveBeenCalled();
  expect(mocks.empty).toHaveBeenCalledWith(
    expect.objectContaining({
      audio,
      transcribeResult: expect.objectContaining({
        rawTranscript: null,
        warnings: [expect.stringContaining("capture stopped")],
      }),
    }),
  );
});

it("routes a transcription failure through failed-audio recovery", async () => {
  mocks.empty.mockClear();
  mocks.context.mockResolvedValue({
    a11yInfo: null,
    appTarget: null,
    toneId: null,
  });
  const session = {
    finalize: vi.fn().mockRejectedValue(new Error("private provider detail")),
    cleanup: vi.fn(),
  } as unknown as TranscriptionSession;
  const strategy = {} as BaseStrategy;
  const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: null },
    sessionRef: { current: session },
    strategyRef: { current: strategy },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  await expect(
    engine.finalizeAndPostProcess({
      audio,
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
  ).resolves.toEqual({ shouldContinue: false });
  expect(session.cleanup).toHaveBeenCalledOnce();
  expect(mocks.empty).toHaveBeenCalledWith(
    expect.objectContaining({
      audio,
      transcribeResult: expect.objectContaining({
        rawTranscript: null,
        warnings: ["Transcription could not be completed"],
      }),
    }),
  );
});

it("saves failed audio when a provider finalization times out", async () => {
  vi.useFakeTimers();
  try {
    mocks.empty.mockClear();
    mocks.context.mockResolvedValue({
      a11yInfo: null,
      appTarget: null,
      toneId: null,
    });
    const session = {
      finalize: vi.fn(() => new Promise(() => {})),
      cleanup: vi.fn(),
    } as unknown as TranscriptionSession;
    const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
    const engine = useRecordingFinalization({
      nativeStartOwnerRef: { current: null },
      sessionRef: { current: session },
      strategyRef: { current: {} as BaseStrategy },
      pipelineTraceRef: { current: null },
      utteranceTonesRef: {
        current: { read: () => ({ start: null, stop: null }) },
      },
      sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
      postProcessFinalizedTranscript: mocks.post,
      handleEmptyTranscriptionResult: mocks.empty,
      surfacePersistedReviewInHistory: vi.fn(),
      formatReviewPersistenceFailure: () => "failed",
    });
    const result = engine.finalizeAndPostProcess({
      audio,
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    });
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(result).resolves.toEqual({ shouldContinue: false });
    expect(session.cleanup).toHaveBeenCalledOnce();
    expect(mocks.empty).toHaveBeenCalledWith(
      expect.objectContaining({
        audio,
        transcribeResult: expect.objectContaining({
          warnings: ["Transcription could not be completed"],
        }),
      }),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("does not start provider finalization if reading the style retires the session", async () => {
  const session = { finalize: vi.fn() } as unknown as TranscriptionSession;
  const sessionRef = { current: session as TranscriptionSession | null };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: null },
    sessionRef,
    strategyRef: { current: {} as BaseStrategy },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: {
        read: () => {
          sessionRef.current = null;
          return { start: null, stop: null };
        },
      },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  await expect(
    engine.finalizeAndPostProcess({
      audio: { samples: new Float32Array([0.5]), sampleRate: 16000 },
      context: Promise.resolve({ a11yInfo: null, appTarget: null }),
    }),
  ).resolves.toEqual({ shouldContinue: false });
  expect(session.finalize).not.toHaveBeenCalled();
});

it("does not postprocess an old recording with a replacement session", async () => {
  mocks.empty.mockClear();
  mocks.post.mockClear();
  let finish!: (value: { a11yInfo: null; appTarget: null }) => void;
  const context = new Promise<{ a11yInfo: null; appTarget: null }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const session = {
    finalize: vi
      .fn()
      .mockResolvedValue({ rawTranscript: "old", metadata: {}, warnings: [] }),
  } as unknown as TranscriptionSession;
  const sessionRef = { current: session };
  const strategyRef = { current: {} as BaseStrategy };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: null },
    sessionRef,
    strategyRef,
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: "old", stop: "old" }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = engine.finalizeAndPostProcess({
    audio: { samples: [1], sampleRate: 16000 },
    context,
  });
  sessionRef.current = {} as TranscriptionSession;
  strategyRef.current = {} as BaseStrategy;
  finish({ a11yInfo: null, appTarget: null });
  await expect(result).resolves.toEqual({ shouldContinue: false });
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.empty).not.toHaveBeenCalled();
});

it("starts transcription while focus context is still pending", async () => {
  let finishContext!: (value: object) => void;
  mocks.context.mockReturnValue(
    new Promise((resolve) => {
      finishContext = resolve;
    }),
  );
  mocks.post.mockResolvedValue({ shouldContinue: true });
  const finalize = vi
    .fn()
    .mockResolvedValue({ rawTranscript: "hello", metadata: {}, warnings: [] });
  const session = { finalize } as unknown as TranscriptionSession;
  const strategy = {} as BaseStrategy;
  const audio = { samples: new Float32Array(), sampleRate: 16_000 };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: { current: null },
    sessionRef: { current: session },
    strategyRef: { current: strategy },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = engine.finalizeAndPostProcess({
    audio,
    context: Promise.resolve({ a11yInfo: null, appTarget: null }),
  });
  expect(finalize).toHaveBeenCalledWith(audio);
  expect(mocks.post).not.toHaveBeenCalled();
  finishContext({ a11yInfo: null, appTarget: null, toneId: null });
  await expect(result).resolves.toEqual({ shouldContinue: true });
  expect(mocks.post).toHaveBeenCalledOnce();
});

it("stops and returns captured audio when stop feedback throws synchronously", async () => {
  vi.mocked(tryPlayAudioChime).mockImplementationOnce(() => {
    throw new Error("chime unavailable");
  });
  vi.mocked(invoke).mockResolvedValue(null);
  vi.mocked(tryRegisterCurrentAppTarget).mockResolvedValue(null);
  mocks.logger.stopwatch.mockImplementation((_name, work) => work());
  const audio = { samples: new Float32Array([0.5]), sampleRate: 16000 };
  const lease = {
    stop: vi.fn().mockResolvedValue(audio),
  } as unknown as NativeRecordingLease;
  const owner = { current: lease as NativeRecordingLease | null };
  const engine = useRecordingFinalization({
    nativeStartOwnerRef: owner,
    sessionRef: { current: null },
    strategyRef: { current: null },
    pipelineTraceRef: { current: null },
    utteranceTonesRef: {
      current: { read: () => ({ start: null, stop: null }) },
    },
    sendPhaseToPill: vi.fn().mockResolvedValue(undefined),
    postProcessFinalizedTranscript: mocks.post,
    handleEmptyTranscriptionResult: mocks.empty,
    surfacePersistedReviewInHistory: vi.fn(),
    formatReviewPersistenceFailure: () => "failed",
  });
  const result = await engine.captureStopRecordingInfo();
  expect(result.audio).toBe(audio);
  expect(lease.stop).toHaveBeenCalledOnce();
  expect(owner.current).toBeNull();
});
