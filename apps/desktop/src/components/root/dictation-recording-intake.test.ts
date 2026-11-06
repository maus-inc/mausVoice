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

import type { BaseStrategy } from "../../strategies/base.strategy";
import type { TranscriptionSession } from "../../types/transcription-session.types";
import {
  beginNativeRecording,
  resetNativeRecordingSession,
  type NativeRecordingHandle,
} from "../../utils/native-recording-session";
import {
  attachSessionAudioIntake,
  createCurrentSegmentGuard,
  forwardAudioChunk,
  isRecordingStartCurrent,
  releaseRecordingResources,
  requiresLiveIntakeRecovery,
  stopNativeRecordingForAbort,
  stopOwnedNativeStart,
  trackNativeStartHandle,
} from "./dictation-recording-intake";

beforeEach(() => {
  resetNativeRecordingSession();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

/** A native admission whose discard is observable through the invoke mock. */
const fakeHandle = (generation: number): NativeRecordingHandle => ({
  ownerId: `owner-${generation}`,
  generation,
  stop: vi.fn(async () => ({
    samples: new Float32Array(0),
    sampleRate: 16_000,
  })),
  discard: vi.fn(async () => {
    await mocks.invoke("discard_recording", {
      ownerId: `owner-${generation}`,
      generation,
    });
  }),
  pause: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  isLive: () => true,
});

const discards = () =>
  mocks.invoke.mock.calls.filter(
    ([command]) => command === "discard_recording",
  );

/** Open a live recording so the module-level teardown paths have a target. */
const startLiveRecording = async (): Promise<NativeRecordingHandle> => {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(1);
    if (command === "start_recording") {
      return Promise.resolve({ sampleRate: 16_000 });
    }
    return Promise.resolve(new ArrayBuffer(4));
  });
  const { handle } = await beginNativeRecording(null);
  return handle;
};

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
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.errorMock.mockClear();
  mocks.warningMock.mockClear();
  mocks.verboseMock.mockClear();
});

describe("requiresLiveIntakeRecovery", () => {
  it("flags a failed subscription only for live-streaming sessions", () => {
    expect(requiresLiveIntakeRecovery("live-streaming", true)).toBe(true);
    expect(requiresLiveIntakeRecovery("after-stop", true)).toBe(false);
    expect(requiresLiveIntakeRecovery("local", true)).toBe(false);
  });

  it("never flags an established subscription", () => {
    expect(requiresLiveIntakeRecovery("live-streaming", false)).toBe(false);
    expect(requiresLiveIntakeRecovery("after-stop", false)).toBe(false);
    expect(requiresLiveIntakeRecovery("local", false)).toBe(false);
  });
});

describe("audio intake ownership", () => {
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

  it("tolerates subscription failure so stop can recover the native recording", async () => {
    // A subscription that cannot be established is not a reason to fail native
    // capture. Non-streaming sessions can transcribe the full recording at stop;
    // live sessions finalize empty and rely on the failed-transcription recovery
    // path to retain audio when the strategy and persistence policy allow.
    mocks.rejectListen = true;
    const intake = await attachSessionAudioIntake(
      sessionWith(vi.fn()),
      () => true,
      () => true,
      noOverflow,
    );
    expect(intake.unlisten).toBeNull();
    expect(intake.current).toBe(true);
    expect(intake.subscriptionFailed).toBe(true);
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
    expect(intake.subscriptionFailed).toBe(false);
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
    expect(mocks.errorMock).toHaveBeenCalledOnce();
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

describe("native capture ownership", () => {
  it("stops the stream for the start that still owns it", async () => {
    const ownerRef = { current: 3 as number | null };
    const handle = fakeHandle(3);
    trackNativeStartHandle(ownerRef, 3, handle);
    await stopOwnedNativeStart(ownerRef, 3);
    expect(discards()).toHaveLength(1);
    expect(handle.discard).toHaveBeenCalledOnce();
    expect(ownerRef.current).toBeNull();
  });

  it("leaves a live stream alone when a superseded start reports in", async () => {
    const ownerRef = { current: 4 as number | null };
    await stopOwnedNativeStart(ownerRef, 3);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(ownerRef.current).toBe(4);
  });

  it("stops on abort even when a restart has already claimed ownership", async () => {
    // The P1. An abort landing while the microphone was still opening used to
    // release the claim, await the pill's idle phase, and only then skip its stop
    // because a restart had claimed in the meantime. With the admission on the
    // handle, the abort stops the exact stream this start opened.
    const ownerRef = { current: 4 as number | null };
    const handle = fakeHandle(4);
    trackNativeStartHandle(ownerRef, 4, handle);
    await stopNativeRecordingForAbort(ownerRef);
    expect(handle.discard).toHaveBeenCalledOnce();
    expect(ownerRef.current).toBeNull();
  });

  it("stops on abort when the claim was already released", async () => {
    // The abort takes the claim itself, so the ref is normally null by the time
    // the stop is issued. It must stop the live recording in that state too.
    const handle = await startLiveRecording();
    const ownerRef = { current: null as number | null };
    await stopNativeRecordingForAbort(ownerRef);
    expect(discards()).toHaveLength(1);
    expect(discards()[0]?.[1]).toEqual({
      ownerId: handle.ownerId,
      generation: handle.generation,
    });
  });

  it("stops the stream a superseded start opened after the abort released its claim", async () => {
    // An abort that lands while a start is still inside `start_recording` stops
    // that start's own admission, so the superseded start's report cannot let a
    // recorder come up live with no owner.
    const ownerRef = { current: 3 as number | null };
    const handle = fakeHandle(3);
    trackNativeStartHandle(ownerRef, 3, handle);
    await stopNativeRecordingForAbort(ownerRef);
    await stopOwnedNativeStart(ownerRef, 3);
    expect(discards()).toHaveLength(1);
  });

  it("does not stop twice when a start that was still opening reports in after its own stop", async () => {
    const ownerRef = { current: 3 as number | null };
    const handle = fakeHandle(3);
    trackNativeStartHandle(ownerRef, 3, handle);
    await stopOwnedNativeStart(ownerRef, 3);
    await stopOwnedNativeStart(ownerRef, 3);
    expect(discards()).toHaveLength(1);
  });

  it("leaves a newer recording's stream alone even when an abort is owed a stop", async () => {
    // The claim names the newer recording, so this stale start must not cut off
    // a live dictation to discharge a debt the abort left behind.
    const ownerRef = { current: 3 as number | null };
    const handle = fakeHandle(3);
    trackNativeStartHandle(ownerRef, 3, handle);
    await stopNativeRecordingForAbort(ownerRef);
    ownerRef.current = 4;
    await stopOwnedNativeStart(ownerRef, 3);
    expect(discards()).toHaveLength(1);
    expect(ownerRef.current).toBe(4);
  });

  it("swallows a stop failure so an abort cannot reject", async () => {
    await startLiveRecording();
    mocks.invoke.mockImplementation((command: string) =>
      command === "discard_recording"
        ? Promise.reject(new Error("no recorder"))
        : Promise.resolve(undefined),
    );
    const ownerRef = { current: null as number | null };
    await expect(
      stopNativeRecordingForAbort(ownerRef),
    ).resolves.toBeUndefined();
    expect(ownerRef.current).toBeNull();
  });

  it("stops the stream once when two starts report in for one owner", async () => {
    const ownerRef = { current: 3 as number | null };
    const handle = fakeHandle(3);
    trackNativeStartHandle(ownerRef, 3, handle);
    await Promise.all([
      stopOwnedNativeStart(ownerRef, 3),
      stopOwnedNativeStart(ownerRef, 3),
    ]);
    expect(discards()).toHaveLength(1);
  });

  it("does not throw when the native stop rejects", async () => {
    const ownerRef = { current: 3 as number | null };
    const handle = fakeHandle(3);
    vi.mocked(handle.discard).mockRejectedValueOnce(
      new Error("no active stream"),
    );
    trackNativeStartHandle(ownerRef, 3, handle);
    await expect(stopOwnedNativeStart(ownerRef, 3)).resolves.toBeUndefined();
    expect(mocks.verboseMock).toHaveBeenCalled();
  });

  it("keeps ownership across a start, stop, and restart interleaving", async () => {
    const ownerRef = { current: null as number | null };

    ownerRef.current = 3;
    const first = fakeHandle(3);
    trackNativeStartHandle(ownerRef, 3, first);
    // A stop lands while start 3 is opening the mic: the stop path releases
    // capture, so the stale start must not issue a second stop.
    await stopOwnedNativeStart(ownerRef, 3);
    expect(discards()).toHaveLength(1);

    // A restart claims ownership again; the old start reports in afterwards.
    ownerRef.current = 4;
    await stopOwnedNativeStart(ownerRef, 3);
    expect(discards()).toHaveLength(1);
    expect(ownerRef.current).toBe(4);
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

describe("releaseRecordingResources", () => {
  it("releases the listener, session, strategy, and native capture on unmount", async () => {
    const unlisten = vi.fn();
    const cleanup = vi.fn();
    const strategyCleanup = vi.fn().mockResolvedValue(undefined);
    const refs = {
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

    await startLiveRecording();
    releaseRecordingResources(refs);

    expect(unlisten).toHaveBeenCalledOnce();
    expect(refs.audioChunkUnlistenRef.current).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(strategyCleanup).toHaveBeenCalledOnce();
    // Unmount is an explicit teardown, so the live recording is discarded.
    await vi.waitFor(() => expect(discards()).toHaveLength(1));
  });

  it("still stops native capture when strategy cleanup rejects", async () => {
    const refs = {
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

    await startLiveRecording();
    expect(() => releaseRecordingResources(refs)).not.toThrow();
    await vi.waitFor(() => expect(discards()).toHaveLength(1));
    expect(mocks.warningMock).toHaveBeenCalled();
  });
});
