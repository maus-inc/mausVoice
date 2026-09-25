import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chunkListener: null as
    | ((event: { payload: { samples: number[]; offset?: number } }) => void)
    | null,
  unlisten: vi.fn(),
  deferListen: false,
  resolveListen: null as (() => void) | null,
  listenCalls: 0,
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
  attachSessionAudioIntake,
  createCurrentSegmentGuard,
  forwardAudioChunk,
  isRecordingStartCurrent,
  releaseRecordingResources,
  stopOwnedNativeStart,
} from "./dictation-recording-intake";

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
  mocks.unlisten.mockClear();
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.errorMock.mockClear();
  mocks.warningMock.mockClear();
  mocks.verboseMock.mockClear();
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

  it("buffers pre-ready chunks and replays them in order with their indexes", async () => {
    const writeAudioChunk = vi.fn();
    let ready = false;
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
    let ready = false;
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
    await stopOwnedNativeStart(ownerRef, 3);
    expect(mocks.invoke).toHaveBeenCalledWith("stop_recording");
    expect(ownerRef.current).toBeNull();
  });

  it("leaves a live stream alone when a superseded start reports in", async () => {
    const ownerRef = { current: 4 as number | null };
    await stopOwnedNativeStart(ownerRef, 3);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(ownerRef.current).toBe(4);
  });

  it("stops the stream once when two starts report in for one owner", async () => {
    const ownerRef = { current: 3 as number | null };
    await Promise.all([
      stopOwnedNativeStart(ownerRef, 3),
      stopOwnedNativeStart(ownerRef, 3),
    ]);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "stop_recording",
      ),
    ).toHaveLength(1);
  });

  it("does not throw when the native stop rejects", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("no active stream"));
    const ownerRef = { current: 3 as number | null };
    await expect(stopOwnedNativeStart(ownerRef, 3)).resolves.toBeUndefined();
    expect(mocks.verboseMock).toHaveBeenCalled();
  });

  it("keeps ownership across a start, stop, and restart interleaving", async () => {
    const ownerRef = { current: null as number | null };

    ownerRef.current = 3;
    // A stop lands while start 3 is opening the mic: the stop path releases
    // capture, so the stale start must not issue a second stop.
    await stopOwnedNativeStart(ownerRef, 3);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "stop_recording",
      ),
    ).toHaveLength(1);

    // A restart claims ownership again; the old start reports in afterwards.
    ownerRef.current = 4;
    await stopOwnedNativeStart(ownerRef, 3);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "stop_recording",
      ),
    ).toHaveLength(1);
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
  it("releases the listener, session, strategy, and native capture on unmount", () => {
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

    releaseRecordingResources(refs);

    expect(unlisten).toHaveBeenCalledOnce();
    expect(refs.audioChunkUnlistenRef.current).toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(strategyCleanup).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("stop_recording");
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

    expect(() => releaseRecordingResources(refs)).not.toThrow();
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledWith("stop_recording");
    expect(mocks.warningMock).toHaveBeenCalled();
  });
});
