import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chunkListener: null as
    | ((event: { payload: { samples: number[]; offset?: number } }) => void)
    | null,
  unlisten: vi.fn(),
  deferListen: false,
  resolveListen: null as (() => void) | null,
  listenCalls: 0,
  rejectListen: false,
  invoke: vi.fn().mockResolvedValue(undefined),
  errorMock: vi.fn(),
  warningMock: vi.fn(),
  verboseMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      event: string,
      listener: (event: {
        payload: { samples: number[]; offset?: number };
      }) => void,
    ) => {
      if (event !== "audio_chunk") throw new Error(`unexpected ${event}`);
      mocks.listenCalls += 1;
      mocks.chunkListener = listener;
      if (mocks.rejectListen) {
        throw new Error("no audio chunk stream");
      }
      if (mocks.deferListen) {
        return new Promise<typeof mocks.unlisten>((resolve) => {
          mocks.resolveListen = () => resolve(mocks.unlisten);
        });
      }
      return mocks.unlisten;
    },
  ),
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: mocks.errorMock,
    warning: mocks.warningMock,
    verbose: mocks.verboseMock,
  }),
}));

import { ActivationController } from "@maus-inc/desktop-utils";
import { monitorAbortRelease } from "./dictation-abort-safety";
import { ContinuousLiveSession } from "../../sessions/continuous-live-session";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import type { BaseStrategy } from "../../strategies/base.strategy";
import { createAudioChunkStartupBuffer } from "../../utils/audio-chunk-startup-buffer";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import {
  attachSessionAudioIntake,
  createCurrentSegmentGuard,
  takeRecordingSession,
  finishAbortedRecording,
  releaseOwnedAudioListener,
  prepareSessionForCapture,
  configureStreamingInterims,
  startNativeCapture,
  claimRecordingStart,
  resolveStartAtNativeDispatch,
  startPreparedSession,
  abortFailedRecordingStart,
  forwardAudioChunk,
  isRecordingStartCurrent,
  releaseRecordingResources,
  stopNativeRecordingForAbort,
} from "./dictation-recording-intake";

const recordingInvoke = (command: string, args?: Record<string, unknown>) =>
  command === "recording_generation"
    ? Promise.resolve(0)
    : mocks.invoke(command, args);

const samples = (length: number, value = 0.25) =>
  Array.from({ length }, () => value);

const sessionWith = (
  writeAudioChunk?: (chunk: Float32Array, offset: number) => void,
): TranscriptionSession =>
  ({
    onRecordingStart: vi.fn(),
    finalize: vi.fn(),
    cleanup: vi.fn(),
    supportsStreaming: () => false,
    setInterimResultCallback: vi.fn(),
    ...(writeAudioChunk ? { writeAudioChunk } : {}),
  }) as unknown as TranscriptionSession;

const strategyStub = (): BaseStrategy =>
  ({ cleanup: vi.fn() }) as unknown as BaseStrategy;

const noOverflow = () => undefined;

/** Emits one `audio_chunk` Tauri event at the given recording index. */
const emitChunk = (values: number[], offset: number | null) =>
  mocks.chunkListener?.({
    payload: { samples: values, ...(offset === null ? {} : { offset }) },
  });

beforeEach(() => {
  mocks.chunkListener = null;
  mocks.deferListen = false;
  mocks.resolveListen = null;
  mocks.listenCalls = 0;
  mocks.rejectListen = false;
  mocks.unlisten.mockClear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "start_recording" ? { sampleRate: 16000 } : undefined,
    ),
  );
  mocks.errorMock.mockClear();
  mocks.warningMock.mockClear();
  mocks.verboseMock.mockClear();
});

describe("audio intake ownership", () => {
  it("drops chunks belonging to another capture before buffering", async () => {
    const write = vi.fn();
    await attachSessionAudioIntake(
      sessionWith(write),
      () => true,
      () => true,
      noOverflow,
      "mine",
    );
    const send = mocks.chunkListener as unknown as (event: {
      payload: { samples: number[]; offset: number; ownerId: string };
    }) => void;
    send({ payload: { samples: [0.5], offset: 0, ownerId: "other" } });
    expect(write).not.toHaveBeenCalled();
    send({ payload: { samples: [0.5], offset: 0, ownerId: "mine" } });
    expect(write).toHaveBeenCalledOnce();
  });

  it("registers exactly one audio_chunk listener per recording", async () => {
    const session = sessionWith(vi.fn());
    await attachSessionAudioIntake(
      session,
      () => true,
      () => true,
      noOverflow,
    );
    expect(mocks.listenCalls).toBe(1);
  });

  it("falls back to the whole recording when the subscription fails", async () => {
    // A subscription that cannot be established is a missing optimisation, not a
    // broken dictation. Letting this reject reached the outer start-failure
    // handler and reported "Recording failed" for a recording that was fine.
    mocks.rejectListen = true;
    const intake = await attachSessionAudioIntake(
      sessionWith(vi.fn()),
      () => true,
      () => true,
      noOverflow,
    );
    expect(intake.unlisten).toBeNull();
    expect(intake.current).toBe(true);
  });

  it("skips registration for a session that takes no live audio", async () => {
    const intake = await attachSessionAudioIntake(
      sessionWith(),
      () => true,
      () => true,
      noOverflow,
    );
    expect(mocks.listenCalls).toBe(0);
    expect(intake.unlisten).toBeNull();
    expect(intake.current).toBe(true);
  });

  it("reports a superseded start that has nothing to attach", async () => {
    const intake = await attachSessionAudioIntake(
      sessionWith(),
      () => false,
      () => true,
      noOverflow,
    );
    expect(mocks.listenCalls).toBe(0);
    expect(intake.current).toBe(false);
  });

  it("does not convert discarded startup samples before applying the buffer cap", async () => {
    const onOverflow = vi.fn();
    const intake = await attachSessionAudioIntake(
      sessionWith(vi.fn()),
      () => true,
      () => false,
      onOverflow,
    );
    intake.buffer.setSampleRate(1); // 30 startup samples
    const oversized = new Proxy(
      Array.from({ length: 35 }, () => 0.25),
      {
        get(target, key, receiver) {
          if (key === "30") throw new Error("read past buffer cap");
          return Reflect.get(target, key, receiver);
        },
      },
    );

    emitChunk(oversized, 0);
    expect(intake.buffer.pendingSampleCount()).toBe(30);
    expect(onOverflow).toHaveBeenCalledWith(5);
  });

  it("forwards a live chunk with its absolute sample index", async () => {
    const writeAudioChunk = vi.fn();
    await attachSessionAudioIntake(
      sessionWith(writeAudioChunk),
      () => true,
      () => true,
      noOverflow,
    );

    emitChunk(samples(4), 1440);

    expect(writeAudioChunk).toHaveBeenCalledOnce();
    const [chunk, offset] = writeAudioChunk.mock.calls[0] as [
      Float32Array,
      number,
    ];
    expect(Array.from(chunk)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(offset).toBe(1440);
  });

  it("drops a chunk whose producer omits the sample index", async () => {
    const writeAudioChunk = vi.fn();
    await attachSessionAudioIntake(
      sessionWith(writeAudioChunk),
      () => true,
      () => true,
      noOverflow,
    );

    emitChunk(samples(4), null);
    emitChunk([], 0);

    expect(writeAudioChunk).not.toHaveBeenCalled();
  });

  it("logs a warning when a chunk omits the sample index", async () => {
    const writeAudioChunk = vi.fn();
    await attachSessionAudioIntake(
      sessionWith(writeAudioChunk),
      () => true,
      () => true,
      noOverflow,
    );

    mocks.warningMock.mockClear();
    emitChunk(samples(4), null);

    expect(writeAudioChunk).not.toHaveBeenCalled();
    expect(mocks.warningMock).toHaveBeenCalledWith(
      expect.stringContaining("no sample offset"),
    );
  });

  it("logs a warning when consecutive chunk offsets are not contiguous", async () => {
    const writeAudioChunk = vi.fn();
    await attachSessionAudioIntake(
      sessionWith(writeAudioChunk),
      () => true,
      () => true,
      noOverflow,
    );

    mocks.warningMock.mockClear();
    emitChunk(samples(2, 0.1), 0);
    emitChunk(samples(2, 0.2), 10);

    expect(writeAudioChunk).toHaveBeenCalledTimes(2);
    expect(mocks.warningMock).toHaveBeenCalledWith(
      expect.stringContaining("Audio offset gap"),
    );
  });

  it("buffers pre-ready chunks and replays them in order with their indexes", async () => {
    const writeAudioChunk = vi.fn();
    const ready = false;
    const intake = await attachSessionAudioIntake(
      sessionWith(writeAudioChunk),
      () => true,
      () => ready,
      noOverflow,
    );

    emitChunk(samples(2, 0.1), 0);
    emitChunk(samples(2, 0.2), 2);
    expect(writeAudioChunk).not.toHaveBeenCalled();
    expect(intake.buffer.pendingSampleCount()).toBe(4);

    intake.buffer.setSink((chunk, offset) =>
      forwardAudioChunk(sessionWith(writeAudioChunk), chunk, offset),
    );
    intake.buffer.replay();

    expect(writeAudioChunk.mock.calls.map(([, offset]) => offset)).toEqual([
      0, 2,
    ]);
    const replayed = writeAudioChunk.mock.calls.map(
      ([chunk]) => (chunk as Float32Array)[0] as number,
    );
    expect(replayed[0]).toBeCloseTo(0.1, 5);
    expect(replayed[1]).toBeCloseTo(0.2, 5);
    expect(intake.buffer.pendingSampleCount()).toBe(0);
  });

  it("reports startup samples dropped by the buffer budget", async () => {
    const onOverflow = vi.fn();
    const ready = false;
    const intake = await attachSessionAudioIntake(
      sessionWith(vi.fn()),
      () => true,
      () => ready,
      onOverflow,
    );

    // 30 s at 48 kHz is the default budget; 32 s of chunks overflow it.
    for (let index = 0; index < 320; index += 1) {
      emitChunk(
        Array.from({ length: 4800 }, () => 0.1),
        index * 4800,
      );
    }

    expect(onOverflow).toHaveBeenCalled();
    expect(intake.buffer.overflowed()).toBe(true);
  });

  it("releases a stale intake listener when the start was superseded", async () => {
    let current = true;
    const session = sessionWith(vi.fn());
    mocks.deferListen = true;
    const pending = attachSessionAudioIntake(
      session,
      () => current,
      () => true,
      noOverflow,
    );
    current = false;
    mocks.resolveListen?.();
    const intake = await pending;

    expect(intake.current).toBe(false);
    expect(intake.unlisten).toBeNull();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("keeps a session throw from escaping the audio_chunk handler", async () => {
    const session = sessionWith(() => {
      throw new Error("provider socket closed");
    });
    await attachSessionAudioIntake(
      session,
      () => true,
      () => true,
      noOverflow,
    );

    expect(() => emitChunk(samples(2), 0)).not.toThrow();
    expect(mocks.errorMock).toHaveBeenCalledExactlyOnceWith(
      "[Dictation] Failed to forward audio chunk",
    );
  });
});

describe("isRecordingStartCurrent", () => {
  const session = sessionWith(vi.fn());
  const strategy = strategyStub();

  it("accepts an operation that still holds its session and strategy", () => {
    expect(
      isRecordingStartCurrent(7, 7, session, session, strategy, strategy),
    ).toBe(true);
  });

  it.each([
    [
      "a newer recording took over",
      (): [
        number,
        number,
        TranscriptionSession | null,
        BaseStrategy | null,
      ] => [7, 8, session, strategy],
    ],
    [
      "the session was replaced",
      (): [
        number,
        number,
        TranscriptionSession | null,
        BaseStrategy | null,
      ] => [7, 7, sessionWith(), strategy],
    ],
    [
      "the session was released",
      (): [
        number,
        number,
        TranscriptionSession | null,
        BaseStrategy | null,
      ] => [7, 7, null, strategy],
    ],
    [
      "the strategy was replaced",
      (): [
        number,
        number,
        TranscriptionSession | null,
        BaseStrategy | null,
      ] => [7, 7, session, strategyStub()],
    ],
    [
      "the strategy was released",
      (): [
        number,
        number,
        TranscriptionSession | null,
        BaseStrategy | null,
      ] => [7, 7, session, null],
    ],
  ])("rejects a superseded start when %s", (_name, operands) => {
    const [operationId, currentOperationId, currentSession, currentStrategy] =
      operands();
    expect(
      isRecordingStartCurrent(
        operationId,
        currentOperationId,
        session,
        currentSession,
        strategy,
        currentStrategy,
      ),
    ).toBe(false);
  });
});

describe("start failure ownership", () => {
  it("delegates the current session and strategy cleanup to abort exactly once", async () => {
    const session = sessionWith();
    const abort = vi.fn().mockResolvedValue(undefined);
    expect(
      abortFailedRecordingStart(new Error("failed"), session, 1, 1, abort),
    ).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(session.cleanup).not.toHaveBeenCalled();
  });
  it("cleans a stale session without aborting its successor", () => {
    const session = sessionWith();
    const abort = vi.fn();
    expect(
      abortFailedRecordingStart(new Error("failed"), session, 1, 2, abort),
    ).toBe(false);
    expect(session.cleanup).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
  });
  it("observes a rejected asynchronous abort", async () => {
    const abort = vi.fn().mockRejectedValue(new Error("abort failure"));
    abortFailedRecordingStart(new Error("failed"), null, 1, 1, abort);
    await vi.waitFor(() =>
      expect(mocks.errorMock).toHaveBeenCalledWith(
        expect.stringContaining("abort failure"),
      ),
    );
  });
});

describe("recording activation dispatch", () => {
  it("cancels and settles a start released before dispatch, even if setup never replies", async () => {
    const release = new AbortController();
    const cancel = vi.fn();
    const pending = resolveStartAtNativeDispatch(
      () => new Promise(() => {}),
      release.signal,
      cancel,
    );
    release.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not cancel a dispatched start when it is released", async () => {
    const release = new AbortController();
    const cancel = vi.fn();
    const pending = resolveStartAtNativeDispatch(
      async (dispatched) => {
        dispatched(12);
        await new Promise(() => {});
        return 12;
      },
      release.signal,
      cancel,
    );
    release.abort();
    await expect(pending).resolves.toBe(12);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("prepared recording startup", () => {
  const setup = () => {
    const session = sessionWith();
    const strategy = {
      onBeforeStart: vi.fn(),
      setPhase: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStrategy;
    const lease = new NativeRecordingLease(recordingInvoke, "dictation-a");
    return { session, strategy, lease };
  };

  it("replays buffered audio only after the provider is ready", async () => {
    const { session, strategy, lease } = setup();
    const buffer = createAudioChunkStartupBuffer();
    buffer.push(new Float32Array([0.5]), 0);
    const write = vi.fn();
    session.writeAudioChunk = write;
    mocks.invoke.mockResolvedValueOnce({ sampleRate: 48000 });
    const ready = vi.fn();
    await expect(
      startPreparedSession({
        session,
        strategy,
        lease,
        buffer,
        isCurrent: () => true,
        preferredMicrophone: null,
        startProviderTimers: vi.fn(),
        markReady: ready,
      }),
    ).resolves.toBe(true);
    expect(session.onRecordingStart).toHaveBeenCalledWith(48000);
    expect(write).toHaveBeenCalledWith(new Float32Array([0.5]), 0);
    expect(ready).toHaveBeenCalledOnce();
  });

  it("stops on key release while provider startup is pending and preserves the captured audio", async () => {
    let finishProvider!: () => void;
    const source = sessionWith(vi.fn());
    source.supportsStreaming = () => true;
    source.onRecordingStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishProvider = resolve;
        }),
    );
    source.finalize = vi.fn().mockResolvedValue({
      rawTranscript: "complete",
      metadata: {},
      warnings: [],
    });
    const session = new ContinuousLiveSession(source);
    const nativeInvoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(42);
      if (command === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      if (command === "stop_recording")
        return Promise.resolve({ sampleRate: 16000, samples: [0.5] });
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(nativeInvoke, "key-hold");
    const strategy = {
      onBeforeStart: vi.fn(),
      setPhase: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStrategy;
    let forward = false;
    const intake = await attachSessionAudioIntake(
      session,
      () => true,
      () => forward,
      noOverflow,
    );
    let operation: number | undefined;
    let result:
      Awaited<ReturnType<TranscriptionSession["finalize"]>> | undefined;
    const controller = new ActivationController(
      async () => {
        operation = await resolveStartAtNativeDispatch(async (captured) => {
          const started = await startPreparedSession({
            session,
            strategy,
            lease,
            buffer: intake.buffer,
            isCurrent: () => true,
            preferredMicrophone: null,
            startProviderTimers: vi.fn(),
            markReady: () => {
              forward = true;
            },
            onNativeStartDispatched: () => captured(7),
          });
          return started ? 7 : undefined;
        });
      },
      async () => {
        expect(operation).toBe(7);
        const audio = await lease.stop();
        result = await session.finalize(audio);
      },
      true,
    );
    controller.handlePress();
    await vi.waitFor(() =>
      expect(source.onRecordingStart).toHaveBeenCalledOnce(),
    );
    emitChunk([0.5], 0);
    controller.handleRelease();
    await vi.waitFor(() =>
      expect(nativeInvoke).toHaveBeenCalledWith("stop_recording", {
        ownerId: "key-hold",
        generation: 42,
      }),
    );
    expect(result).toBeUndefined();
    expect(source.finalize).not.toHaveBeenCalled();
    finishProvider();
    await vi.waitFor(() => expect(result?.rawTranscript).toBe("complete"));
    expect(source.writeAudioChunk).toHaveBeenCalledExactlyOnceWith(
      new Float32Array([0.5]),
      0,
    );
    expect(source.finalize).toHaveBeenCalledWith({
      samples: new Float32Array([0.5]),
      sampleRate: 16000,
    });
    expect(
      nativeInvoke.mock.calls.some(
        ([command]) => command === "discard_recording",
      ),
    ).toBe(false);
    intake.unlisten?.();
    controller.dispose();
  });

  it("releases capture even when the native start reply is delayed", async () => {
    let finishNative!: (value: { sampleRate: number }) => void;
    const nativeInvoke = vi.fn((command: string) => {
      if (command === "recording_generation") return Promise.resolve(9);
      if (command === "start_recording")
        return new Promise<{ sampleRate: number }>((resolve) => {
          finishNative = resolve;
        });
      if (command === "stop_recording")
        return Promise.resolve({ sampleRate: 16000, samples: [0.5] });
      return Promise.resolve(undefined);
    });
    const lease = new NativeRecordingLease(nativeInvoke, "slow-native");
    const session = sessionWith();
    const strategy = {
      onBeforeStart: vi.fn(),
      setPhase: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStrategy;
    let current = true;
    let operation: number | undefined;
    let stoppedSamples: number[] | undefined;
    let startup!: Promise<boolean>;
    const controller = new ActivationController(
      async () => {
        operation = await resolveStartAtNativeDispatch(async (dispatched) => {
          startup = startPreparedSession({
            session,
            strategy,
            lease,
            buffer: createAudioChunkStartupBuffer(),
            isCurrent: () => current,
            preferredMicrophone: null,
            startProviderTimers: vi.fn(),
            markReady: vi.fn(),
            onNativeStartDispatched: () => dispatched(10),
          });
          return (await startup) ? 10 : undefined;
        });
      },
      async () => {
        expect(operation).toBe(10);
        stoppedSamples = Array.from((await lease.stop()).samples);
        current = false;
      },
      true,
    );
    controller.handlePress();
    await vi.waitFor(() =>
      expect(nativeInvoke).toHaveBeenCalledWith(
        "start_recording",
        expect.anything(),
      ),
    );
    controller.handleRelease();
    await vi.waitFor(() => expect(stoppedSamples).toEqual([0.5]));
    expect(session.onRecordingStart).not.toHaveBeenCalled();
    finishNative({ sampleRate: 16000 });
    await expect(startup).resolves.toBe(false);
    expect(
      nativeInvoke.mock.calls.some(
        ([command]) => command === "discard_recording",
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("stops its own pending native start after retirement", async () => {
    const { session, strategy, lease } = setup();
    let open!: (value: { sampleRate: number }) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    let current = true;
    const start = startPreparedSession({
      session,
      strategy,
      lease,
      buffer: createAudioChunkStartupBuffer(),
      isCurrent: () => current,
      preferredMicrophone: null,
      startProviderTimers: vi.fn(),
      markReady: vi.fn(),
    });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    current = false;
    open({ sampleRate: 48000 });
    await expect(start).resolves.toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "dictation-a",
      generation: expect.any(Number),
    });
  });

  it("starts capture and the provider even when the phase reply never arrives", async () => {
    const { session, strategy, lease } = setup();
    vi.mocked(strategy.setPhase).mockReturnValue(new Promise(() => {}));
    mocks.invoke.mockResolvedValueOnce({ sampleRate: 48000 });
    const outcome = await Promise.race([
      startPreparedSession({
        session,
        strategy,
        lease,
        buffer: createAudioChunkStartupBuffer(),
        isCurrent: () => true,
        preferredMicrophone: null,
        startProviderTimers: vi.fn(),
        markReady: vi.fn(),
      }),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 100),
      ),
    ]);
    expect(outcome).toBe(true);
    expect(session.onRecordingStart).toHaveBeenCalledWith(48000);
  });

  it("does not turn a phase failure into a failed recording start", async () => {
    const { session, strategy, lease } = setup();
    vi.mocked(strategy.setPhase).mockRejectedValue(new Error("phase failed"));
    mocks.invoke.mockResolvedValueOnce({ sampleRate: 48000 });
    await expect(
      startPreparedSession({
        session,
        strategy,
        lease,
        buffer: createAudioChunkStartupBuffer(),
        isCurrent: () => true,
        preferredMicrophone: null,
        startProviderTimers: vi.fn(),
        markReady: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(mocks.warningMock).toHaveBeenCalledWith(
      "Could not request pill phase recording",
    );
  });

  it("cleans and stops a session retired while its provider starts", async () => {
    const { session, strategy, lease } = setup();
    let finish!: () => void;
    session.onRecordingStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mocks.invoke.mockResolvedValueOnce({ sampleRate: 48000 });
    let current = true;
    const ready = vi.fn();
    const start = startPreparedSession({
      session,
      strategy,
      lease,
      buffer: createAudioChunkStartupBuffer(),
      isCurrent: () => current,
      preferredMicrophone: null,
      startProviderTimers: vi.fn(),
      markReady: ready,
    });
    await vi.waitFor(() =>
      expect(session.onRecordingStart).toHaveBeenCalledOnce(),
    );
    current = false;
    finish();
    await expect(start).resolves.toBe(false);
    expect(session.cleanup).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "dictation-a",
      generation: expect.any(Number),
    });
    expect(ready).not.toHaveBeenCalled();
  });
});

describe("native capture startup", () => {
  it("starts the provider timer when capture is dispatched, before its reply", async () => {
    let finish!: (value: { sampleRate: number }) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const timer = vi.fn();
    const lease = new NativeRecordingLease(recordingInvoke, "timer-a");
    const opening = startNativeCapture(lease, "Mic", () => true, timer);
    await vi.waitFor(() => expect(timer).toHaveBeenCalledOnce());
    finish({ sampleRate: 48000 });
    await expect(opening).resolves.toEqual({ sampleRate: 48000 });
    expect(mocks.invoke).toHaveBeenCalledWith("start_recording", {
      ownerId: "timer-a",
      generation: 0,
      args: { preferredMicrophone: "Mic", waitForRelease: true },
    });
    expect(timer).toHaveBeenCalledOnce();
  });
  it("does not start a timer for a retired capture", async () => {
    mocks.invoke.mockResolvedValueOnce({ sampleRate: 48000 });
    const timer = vi.fn();
    await expect(
      startNativeCapture(
        new NativeRecordingLease(recordingInvoke, "timer-b"),
        null,
        () => false,
        timer,
      ),
    ).rejects.toThrow("closed");
    expect(timer).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "start_recording",
      expect.anything(),
    );
  });
  it("propagates native errors after arming the dispatch deadline", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("microphone failure"));
    const timer = vi.fn();
    await expect(
      startNativeCapture(
        new NativeRecordingLease(recordingInvoke, "timer-c"),
        null,
        () => true,
        timer,
      ),
    ).rejects.toThrow("microphone failure");
    expect(timer).toHaveBeenCalledOnce();
  });
});

describe("native capture ownership", () => {
  it("does not send any stop when there is no owned capture", async () => {
    await stopNativeRecordingForAbort({ current: null });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("retains the old ID when a successor replaces the ref while stop is pending", async () => {
    let open!: (value: { sampleRate: number }) => void;
    mocks.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    const old = new NativeRecordingLease(recordingInvoke, "old");
    const newer = new NativeRecordingLease(recordingInvoke, "new");
    const opening = old.start(null);
    await Promise.resolve();
    const ref = { current: old as NativeRecordingLease | null };
    const stop = stopNativeRecordingForAbort(ref);
    ref.current = newer;
    open({ sampleRate: 16000 });
    await Promise.all([opening, stop]);
    expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: "old",
      generation: expect.any(Number),
    });
    expect(ref.current).toBe(newer);
  });
  it("keeps cancellation guidance when a real lease's discard is rejected", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ sampleRate: 16000 })
      .mockRejectedValueOnce(new Error("release is pending"));
    // Use a separate transport identity so this intentionally unconfirmed
    // release does not affect later tests' pending-release registry.
    const invoke = (command: string, args?: Record<string, unknown>) =>
      recordingInvoke(command, args);
    const lease = new NativeRecordingLease(invoke, "old");
    await lease.start(null);
    const ref = { current: lease as NativeRecordingLease | null };
    const show = vi.fn();
    const dismiss = vi.fn();
    const safety = monitorAbortRelease({
      isCurrent: () => true,
      show,
      dismiss,
      immediately: true,
    });
    const cleanup = stopNativeRecordingForAbort(ref, safety.failed);
    safety.watch(cleanup);
    await cleanup;
    await Promise.resolve();
    expect(safety.isFailed()).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("retries a rejected real-lease discard before dismissing its warning", async () => {
    vi.useFakeTimers();
    try {
      mocks.invoke
        .mockResolvedValueOnce({ sampleRate: 16000 })
        .mockRejectedValueOnce(new Error("release is pending"))
        .mockResolvedValueOnce(undefined);
      const invoke = (command: string, args?: Record<string, unknown>) =>
        recordingInvoke(command, args);
      const lease = new NativeRecordingLease(invoke, "retry-old");
      await lease.start(null);
      const ref = { current: lease as NativeRecordingLease | null };
      const show = vi.fn();
      const dismiss = vi.fn();
      const safety = monitorAbortRelease({
        isCurrent: () => true,
        show,
        dismiss,
        immediately: true,
        retry: () => lease.cancel(),
      });
      const cleanup = stopNativeRecordingForAbort(ref, safety.failed);
      safety.watch(cleanup);
      await cleanup;
      expect(safety.isFailed()).toBe(true);
      expect(dismiss).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "retry-old",
        generation: 0,
      });
      expect(dismiss).toHaveBeenCalledOnce();
      expect(safety.isFailed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the lease reachable when cancellation throws synchronously", async () => {
    const lease = {
      cancel: vi.fn(() => {
        throw new Error("cancel failed");
      }),
    } as unknown as NativeRecordingLease;
    const ref = { current: lease as NativeRecordingLease | null };
    const unconfirmed = vi.fn();
    await expect(
      stopNativeRecordingForAbort(ref, unconfirmed),
    ).resolves.toBeUndefined();
    expect(unconfirmed).toHaveBeenCalledOnce();
    expect(ref.current).toBe(lease);
    expect(mocks.verboseMock).toHaveBeenCalled();
  });

  it("handles a rejected owned stop without rejecting abort", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ sampleRate: 16000 })
      .mockRejectedValueOnce(new Error("stop failed"));
    const lease = new NativeRecordingLease(recordingInvoke, "old");
    await lease.start(null);
    const ref = { current: lease as NativeRecordingLease | null };
    const unconfirmed = vi.fn();
    await expect(
      stopNativeRecordingForAbort(ref, unconfirmed),
    ).resolves.toBeUndefined();
    expect(ref.current).toBeNull();
    expect(unconfirmed).toHaveBeenCalledOnce();
    expect(mocks.verboseMock).toHaveBeenCalled();
  });
});

describe("createCurrentSegmentGuard", () => {
  it("forwards a segment from the live recording", () => {
    const handleInterimSegment = vi.fn();
    const guard = createCurrentSegmentGuard(2, () => 2, handleInterimSegment);
    guard("hello");
    expect(handleInterimSegment).toHaveBeenCalledWith("hello");
  });

  it("drops an interim segment produced by a superseded recording", () => {
    const handleInterimSegment = vi.fn();
    const guard = createCurrentSegmentGuard(2, () => 5, handleInterimSegment);
    guard("stale");
    expect(handleInterimSegment).not.toHaveBeenCalled();
  });
});

describe("streaming interim ownership", () => {
  it("forwards only interim segments for the current recording", () => {
    const session = sessionWith();
    session.supportsStreaming = () => true;
    const strategy = {
      handleInterimSegment: vi.fn(),
    } as unknown as BaseStrategy;
    let current = 1;
    configureStreamingInterims(session, strategy, 1, () => current);
    const callback = vi.mocked(session.setInterimResultCallback).mock
      .calls[0][0];
    callback("live");
    current = 2;
    callback("stale");
    expect(strategy.handleInterimSegment).toHaveBeenCalledExactlyOnceWith(
      "live",
      expect.any(Function),
    );
  });
  it("drops interim segments immediately when the recording's auth session retires", () => {
    const session = sessionWith();
    session.supportsStreaming = () => true;
    const strategy = {
      handleInterimSegment: vi.fn(),
    } as unknown as BaseStrategy;
    let current = true;
    configureStreamingInterims(
      session,
      strategy,
      1,
      () => 1,
      () => current,
    );
    const callback = vi.mocked(session.setInterimResultCallback).mock
      .calls[0][0];
    callback("before");
    current = false;
    callback("after");
    expect(strategy.handleInterimSegment).toHaveBeenCalledExactlyOnceWith(
      "before",
      expect.any(Function),
    );
  });
  it("does not install an interim handler on a batch session", () => {
    const session = sessionWith();
    configureStreamingInterims(session, strategyStub(), 1, () => 1);
    expect(session.setInterimResultCallback).not.toHaveBeenCalled();
  });
});

describe("session pre-capture setup", () => {
  it("continues after a recoverable pre-capture failure", async () => {
    const session = sessionWith();
    session.onBeforeRecordingStart = vi
      .fn()
      .mockRejectedValue(new Error("unavailable"));
    await expect(prepareSessionForCapture(session, () => true)).resolves.toBe(
      true,
    );
    expect(session.cleanup).not.toHaveBeenCalled();
    expect(mocks.warningMock).toHaveBeenCalledWith(
      expect.stringContaining("unavailable"),
    );
  });
  it("cleans a session retired while setup was pending", async () => {
    const session = sessionWith();
    let finish!: () => void;
    session.onBeforeRecordingStart = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    let current = true;
    const setup = prepareSessionForCapture(session, () => current);
    current = false;
    finish();
    await expect(setup).resolves.toBe(false);
    expect(session.cleanup).toHaveBeenCalledOnce();
  });
});

describe("audio listener ownership release", () => {
  it("retires the listener even when unlisten throws", () => {
    const failing = vi.fn(() => {
      throw new Error("unlisten failed");
    });
    const ref = { current: failing as (() => void) | null };
    expect(() => releaseOwnedAudioListener(ref, failing)).not.toThrow();
    expect(ref.current).toBeNull();
    expect(failing).toHaveBeenCalledOnce();
    expect(mocks.warningMock).toHaveBeenCalledWith(
      expect.stringContaining("unlisten failed"),
    );
  });
  it("does not release a listener already replaced by a newer start", () => {
    const previous = vi.fn();
    const current = vi.fn();
    const ref = { current: current as (() => void) | null };
    releaseOwnedAudioListener(ref, previous);
    expect(current).not.toHaveBeenCalled();
    expect(ref.current).toBe(current);
  });
});

describe("abort ownership", () => {
  it("retires only the captured session and does not clear a newer recording", async () => {
    const oldSession = sessionWith();
    let finishStrategy!: () => void;
    let startedStrategy!: () => void;
    const started = new Promise<void>((resolve) => {
      startedStrategy = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishStrategy = resolve;
    });
    const oldStrategy = {
      cleanup: vi.fn(() => {
        startedStrategy();
        return pending;
      }),
    } as unknown as BaseStrategy;
    const refs = {
      sessionRef: { current: oldSession as TranscriptionSession | null },
      strategyRef: { current: oldStrategy as BaseStrategy | null },
    };
    const owned = takeRecordingSession(refs);
    expect(refs.sessionRef.current).toBeNull();
    expect(refs.strategyRef.current).toBeNull();
    let currentId = 4;
    const clearState = vi.fn();
    const cleanup = finishAbortedRecording(
      owned,
      4,
      () => currentId,
      clearState,
    );
    await started;
    const nextSession = sessionWith();
    const nextStrategy = strategyStub();
    refs.sessionRef.current = nextSession;
    refs.strategyRef.current = nextStrategy;
    currentId = 5;
    finishStrategy();
    await cleanup;
    expect(oldSession.cleanup).toHaveBeenCalledOnce();
    expect(refs.sessionRef.current).toBe(nextSession);
    expect(refs.strategyRef.current).toBe(nextStrategy);
    expect(nextSession.cleanup).not.toHaveBeenCalled();
    expect(clearState).not.toHaveBeenCalled();
  });
  it("retire old strategy internals without clearing a reentrant successor", async () => {
    let currentId = 1;
    const session = sessionWith();
    vi.mocked(session.cleanup).mockImplementation(() => {
      currentId = 2;
    });
    const clearShared = vi.fn();
    const cleanup = vi.fn(async (isCurrent?: () => boolean) => {
      if (isCurrent?.()) clearShared();
    });
    const clearState = vi.fn();
    await finishAbortedRecording(
      { session, strategy: { cleanup } as unknown as BaseStrategy },
      1,
      () => currentId,
      clearState,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(clearShared).not.toHaveBeenCalled();
    expect(clearState).not.toHaveBeenCalled();
  });
  it("clears state for the current abort even if cleanup fails", async () => {
    const session = sessionWith();
    vi.mocked(session.cleanup).mockImplementation(() => {
      throw new Error("session cleanup");
    });
    const strategy = {
      cleanup: vi.fn().mockRejectedValue(new Error("strategy cleanup")),
    } as unknown as BaseStrategy;
    const clearState = vi.fn();
    await finishAbortedRecording({ session, strategy }, 1, () => 1, clearState);
    expect(clearState).toHaveBeenCalledOnce();
    expect(mocks.warningMock).toHaveBeenCalledTimes(2);
  });
});

describe("releaseRecordingResources", () => {
  const ownedLease = async () => {
    const lease = new NativeRecordingLease(recordingInvoke, "unmount-owner");
    await lease.start(null);
    return { current: lease as NativeRecordingLease | null };
  };
  it("releases the listener, session, strategy, and native capture on unmount", async () => {
    const unlisten = vi.fn();
    const cleanup = vi.fn();
    const strategyCleanup = vi.fn().mockResolvedValue(undefined);
    const refs = {
      nativeStartOwnerRef: await ownedLease(),
      audioChunkUnlistenRef: { current: unlisten as typeof unlisten | null },
      sessionRef: {
        current: sessionWith() as unknown as TranscriptionSession | null,
      },
      strategyRef: {
        current: { cleanup: strategyCleanup } as unknown as BaseStrategy | null,
      },
    };
    refs.sessionRef.current = {
      ...(refs.sessionRef.current as TranscriptionSession),
      cleanup,
    } as TranscriptionSession;

    releaseRecordingResources(refs);

    expect(unlisten).toHaveBeenCalledOnce();
    expect(refs.audioChunkUnlistenRef.current).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(strategyCleanup).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "unmount-owner",
        generation: expect.any(Number),
      }),
    );
  });

  it("releases only the resources captured before reentrant unmount cleanup", () => {
    const oldSession = { cleanup: vi.fn() } as unknown as TranscriptionSession;
    const oldStrategy = {
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStrategy;
    const oldLease = {
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as NativeRecordingLease;
    const newSession = { cleanup: vi.fn() } as unknown as TranscriptionSession;
    const newStrategy = {
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as BaseStrategy;
    const newLease = {
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as NativeRecordingLease;
    const refs = {
      nativeStartOwnerRef: { current: oldLease as NativeRecordingLease | null },
      sessionRef: { current: oldSession as TranscriptionSession | null },
      strategyRef: { current: oldStrategy as BaseStrategy | null },
      audioChunkUnlistenRef: { current: null as (() => void) | null },
    };
    let current = true;
    refs.audioChunkUnlistenRef.current = () => {
      current = false;
      refs.nativeStartOwnerRef.current = newLease;
      refs.sessionRef.current = newSession;
      refs.strategyRef.current = newStrategy;
    };
    releaseRecordingResources({ ...refs, isCurrent: () => current });
    expect(oldSession.cleanup).toHaveBeenCalledOnce();
    expect(oldStrategy.cleanup).toHaveBeenCalledOnce();
    const guard = vi.mocked(oldStrategy.cleanup).mock.calls[0][0];
    expect(guard?.()).toBe(false);
    expect(oldLease.cancel).toHaveBeenCalledOnce();
    expect(newSession.cleanup).not.toHaveBeenCalled();
    expect(newStrategy.cleanup).not.toHaveBeenCalled();
    expect(newLease.cancel).not.toHaveBeenCalled();
    expect(refs.nativeStartOwnerRef.current).toBe(newLease);
    expect(refs.sessionRef.current).toBe(newSession);
    expect(refs.strategyRef.current).toBe(newStrategy);
  });

  it("still stops native capture when strategy cleanup rejects", async () => {
    const refs = {
      nativeStartOwnerRef: await ownedLease(),
      audioChunkUnlistenRef: { current: null as (() => void) | null },
      sessionRef: { current: null as TranscriptionSession | null },
      strategyRef: {
        current: {
          cleanup: vi
            .fn()
            .mockRejectedValue(new Error("strategy already gone")),
        } as unknown as BaseStrategy | null,
      },
    };

    expect(() => releaseRecordingResources(refs)).not.toThrow();
    await Promise.resolve();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: "unmount-owner",
        generation: expect.any(Number),
      }),
    );
    expect(mocks.warningMock).toHaveBeenCalled();
  });

  it.each(["listener", "session", "strategy"])(
    "attempts every release and stops native capture if %s cleanup throws synchronously",
    async (failing) => {
      const unlisten = vi.fn(() => {
        if (failing === "listener") throw new Error("listener failed");
      });
      const sessionCleanup = vi.fn(() => {
        if (failing === "session") throw new Error("session failed");
      });
      const strategyCleanup = vi.fn(() => {
        if (failing === "strategy") throw new Error("strategy failed");
        return Promise.resolve();
      });
      const refs = {
        nativeStartOwnerRef: await ownedLease(),
        audioChunkUnlistenRef: { current: unlisten as (() => void) | null },
        sessionRef: {
          current: {
            ...sessionWith(),
            cleanup: sessionCleanup,
          } as TranscriptionSession | null,
        },
        strategyRef: {
          current: {
            cleanup: strategyCleanup,
          } as unknown as BaseStrategy | null,
        },
      };
      expect(() => releaseRecordingResources(refs)).not.toThrow();
      expect(unlisten).toHaveBeenCalledOnce();
      expect(refs.audioChunkUnlistenRef.current).toBeNull();
      expect(sessionCleanup).toHaveBeenCalledOnce();
      expect(strategyCleanup).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(mocks.invoke).toHaveBeenCalledWith("discard_recording", {
          ownerId: "unmount-owner",
          generation: expect.any(Number),
        }),
      );
      expect(mocks.warningMock).toHaveBeenCalled();
    },
  );

  it("reports a rejected native stop without an unhandled rejection", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ sampleRate: 16000 })
      .mockRejectedValueOnce(new Error("native stop failed"));
    releaseRecordingResources({
      nativeStartOwnerRef: await ownedLease(),
      audioChunkUnlistenRef: { current: null },
      sessionRef: { current: null },
      strategyRef: { current: null },
    });
    await vi.waitFor(() =>
      expect(mocks.warningMock).toHaveBeenCalledWith(
        expect.stringContaining("Native capture cleanup failed during unmount"),
      ),
    );
  });
});

describe("recording startup admission", () => {
  it("refuses competing starts without retiring the current operation", () => {
    const operationRef = { current: 10 };
    const pendingRef: { current: { operation: number } | null } = {
      current: null,
    };
    const base = {
      operationRef,
      pendingRef,
      isStopping: false,
      hasNativeLease: false,
      currentMode: null,
      requestedMode: "dictate" as const,
    };
    const first = claimRecordingStart(base);
    expect(first?.operation).toBe(11);
    expect(claimRecordingStart(base)).toBeNull();
    expect(operationRef.current).toBe(11);
    pendingRef.current = null;
    expect(claimRecordingStart({ ...base, hasNativeLease: true })).toBeNull();
    expect(claimRecordingStart({ ...base, isStopping: true })).toBeNull();
    expect(claimRecordingStart({ ...base, currentMode: "agent" })).toBeNull();
    expect(operationRef.current).toBe(11);
  });

  it("permits a new start after an abort retires an unresolved attempt", () => {
    const operationRef = { current: 1 };
    const pendingRef: { current: { operation: number } | null } = {
      current: null,
    };
    const base = {
      operationRef,
      pendingRef,
      isStopping: false,
      hasNativeLease: false,
      currentMode: "agent" as const,
      requestedMode: "agent" as const,
    };
    const old = claimRecordingStart(base);
    expect(old?.operation).toBe(2);
    operationRef.current += 1;
    const replacement = claimRecordingStart(base);
    expect(replacement?.operation).toBe(4);
    expect(replacement).not.toBe(old);
    expect(pendingRef.current).toBe(replacement);
  });
});
