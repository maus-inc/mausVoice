import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unlisten: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import {
  createRecordingAudioRelay,
  MAX_BUFFERED_SAMPLES,
  startCaptureWithSessionAudio,
} from "./recording-audio-relay";
import type {
  AudioChunkSink,
  RecordingAudioRelay,
} from "./recording-audio-relay";
import type { TranscriptionSession } from "../types/transcription-session.types";

/** The handler the relay handed to `listen`, the way the recorder drives it. */
const emitChunk = (samples: number[], offset: number | null) => {
  const handler = mocks.listen.mock.calls.at(-1)?.[1] as
    | ((event: {
        payload: { samples: number[]; offset: number | null };
      }) => void)
    | undefined;
  if (!handler) throw new Error("no audio_chunk listener was registered");
  handler({ payload: { samples, offset } });
};

type Delivered = { samples: number[]; offset: number | null };
const collector = () => {
  const delivered: Delivered[] = [];
  const sink: AudioChunkSink = (samples, offset) =>
    delivered.push({ samples, offset });
  return { delivered, sink };
};

const stubSession = (
  overrides: Partial<TranscriptionSession> = {},
): TranscriptionSession => ({
  onRecordingStart: vi.fn(async () => undefined),
  finalize: vi.fn(async () => ({
    rawTranscript: null,
    metadata: {},
    warnings: [],
  })),
  cleanup: vi.fn(),
  supportsStreaming: () => false,
  setInterimResultCallback: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockResolvedValue(mocks.unlisten);
});

describe("RecordingAudioRelay", () => {
  it("replays the chunks that arrived before a sink bound, in order and once", async () => {
    const relay = createRecordingAudioRelay();
    await relay.attach();
    emitChunk([1, 2], 0);
    emitChunk([3, 4], 2);
    expect(relay.bufferedSampleCount).toBe(4);

    const { delivered, sink } = collector();
    expect(relay.bind(sink)).toBe(true);
    expect(delivered).toEqual([
      { samples: [1, 2], offset: 0 },
      { samples: [3, 4], offset: 2 },
    ]);
    expect(relay.bufferedSampleCount).toBe(0);

    // A rebound sink sees only what arrives after it, never a replay.
    relay.bind(sink);
    emitChunk([5], 4);
    expect(delivered).toEqual([
      { samples: [1, 2], offset: 0 },
      { samples: [3, 4], offset: 2 },
      { samples: [5], offset: 4 },
    ]);
  });

  it("keeps buffered audio across an unbind, because a rebind is still the same recording", async () => {
    const relay = createRecordingAudioRelay();
    await relay.attach();
    emitChunk([1, 2], 0);

    relay.unbind();
    expect(mocks.unlisten).not.toHaveBeenCalled();
    expect(relay.bufferedSampleCount).toBe(2);

    const { delivered, sink } = collector();
    expect(relay.bind(sink)).toBe(true);
    expect(delivered).toEqual([{ samples: [1, 2], offset: 0 }]);
  });

  it("reports an overflowed stream rather than replaying a hole", async () => {
    const relay = createRecordingAudioRelay();
    await relay.attach();
    emitChunk(
      Array.from({ length: MAX_BUFFERED_SAMPLES }, () => 0.1),
      0,
    );
    emitChunk([1], MAX_BUFFERED_SAMPLES);

    const { delivered, sink } = collector();
    expect(relay.bind(sink)).toBe(false);
    expect(delivered).toEqual([]);
  });

  it("stops delivering once released and ignores a late attach", async () => {
    const relay = createRecordingAudioRelay();
    await relay.attach();
    const { delivered, sink } = collector();
    relay.bind(sink);

    relay.release();
    relay.release();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);

    emitChunk([1], 0);
    expect(delivered).toEqual([]);
    await expect(relay.attach()).rejects.toThrow(/released/);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });
});

describe("startCaptureWithSessionAudio", () => {
  it("registers the stream before capture starts", async () => {
    const relays: RecordingAudioRelay[] = [];
    const session = stubSession({
      consumesAudioChunkRelay: true,
      attachAudioChunkRelay: (relay) => relays.push(relay),
    });
    const { delivered, sink } = collector();

    await startCaptureWithSessionAudio(session, async () => {
      // Capture is running by now, so the relay is already listening and the
      // session is holding the first chunks.
      expect(mocks.listen).toHaveBeenCalledWith(
        "audio_chunk",
        expect.any(Function),
      );
      expect(relays).toHaveLength(1);
      emitChunk([1, 2], 0);
      emitChunk([3], 2);
      expect(relays[0]?.bind(sink)).toBe(true);
      expect(delivered).toEqual([
        { samples: [1, 2], offset: 0 },
        { samples: [3], offset: 2 },
      ]);
      return "started";
    });

    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });

  it("opens no listener for a session that does not read the live stream", async () => {
    const session = stubSession();
    await expect(
      startCaptureWithSessionAudio(session, async () => "started"),
    ).resolves.toBe("started");
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("still starts capture when the stream cannot be registered", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("no event permission"));
    const attachAudioChunkRelay = vi.fn();
    const session = stubSession({
      consumesAudioChunkRelay: true,
      attachAudioChunkRelay,
    });

    await expect(
      startCaptureWithSessionAudio(session, async () => "started"),
    ).resolves.toBe("started");
    expect(attachAudioChunkRelay).not.toHaveBeenCalled();
  });
});
