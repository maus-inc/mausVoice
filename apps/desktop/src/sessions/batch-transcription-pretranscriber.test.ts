import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../actions/transcribe.actions", () => ({
  transcribeAudio: mocks.transcribeAudio,
}));
vi.mock("../actions/toast.actions", () => ({
  showToast: mocks.showToast,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

import { BatchTranscriptionSession } from "./batch-transcription-session";

/**
 * The component owns the `audio_chunk` registration, so a cloud session
 * receives live samples through `writeAudioChunk` together with their absolute
 * sample index. These cover the session half of that contract.
 */
const RATE = 1_000;
const speech = (seconds: number, seed: number) => {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = 0.4 * Math.sin(index * 0.7 + seed);
  }
  return out;
};
const silence = (seconds: number, seed: number) => {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = 0.0005 * Math.sin(index * 0.7 + seed);
  }
  return out;
};
const concat = (...parts: Float32Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
/** 13 s of speech clears the 12 s cloud minimum, then a 500 ms pause cuts. */
const CUTTABLE = concat(speech(13, 1), silence(0.5, 2), speech(1, 3));

const feed = (session: BatchTranscriptionSession, audio: Float32Array) => {
  for (let offset = 0; offset < audio.length; offset += 100) {
    session.writeAudioChunk(audio.subarray(offset, offset + 100), offset);
  }
};

const wholeRecording = (text: string) => ({
  rawTranscript: text,
  sanitizedTranscript: text,
  metadata: { transcriptionMode: "api", transcriptionDurationMs: 900 },
  warnings: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transcribeAudio.mockResolvedValue(wholeRecording("whole"));
});

describe("BatchTranscriptionSession pause pretranscription", () => {
  it("pretranscribes a cuttable recording instead of the whole recording", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    feed(session, CUTTABLE);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.transcribeAudio).toHaveBeenCalledTimes(2);
    expect(result.rawTranscript).not.toBe("whole");
  });

  it("transcribes the whole recording when the listener never fired", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(mocks.transcribeAudio.mock.calls[0][0].samples.length).toBe(
      CUTTABLE.length,
    );
    expect(result.rawTranscript).toBe("whole");
  });

  it("transcribes the whole recording when a span request fails", async () => {
    mocks.transcribeAudio.mockRejectedValueOnce(new Error("rate limited"));
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    feed(session, CUTTABLE);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    // The committed span and the tail both fail, so the whole recording runs.
    expect(mocks.transcribeAudio).toHaveBeenCalledTimes(3);
    expect(result.rawTranscript).toBe("whole");
  });

  it("disables pretranscription when the live stream skipped samples", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    session.writeAudioChunk(CUTTABLE.subarray(0, 10_000), 0);
    session.writeAudioChunk(CUTTABLE.subarray(10_000, 15_000), 40_000);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.transcribeAudio).toHaveBeenCalledOnce();
    expect(result.rawTranscript).toBe("whole");
  });

  it("reports an empty recording instead of calling the provider", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);

    const result = await session.finalize({ samples: [], sampleRate: 0 });

    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    expect(result.rawTranscript).toBeNull();
  });

  it("tolerates a live chunk after cleanup", async () => {
    const session = new BatchTranscriptionSession();
    await session.onRecordingStart(RATE);
    session.cleanup();

    expect(() =>
      session.writeAudioChunk(new Float32Array([0.1]), 0),
    ).not.toThrow();
  });
});
