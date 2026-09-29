import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { createDefaultPreferences } from "../actions/user.actions";
import { LocalTranscribeAudioRepo } from "../repos/transcribe-audio.repo";
import { LocalTranscriptionSession } from "./local-transcription-session";
import { gateSilentSegments } from "../utils/hallucination.utils";

const mocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
  transcribeAudio: vi.fn(),
  createStreamingSession: vi.fn(),
  finalize: vi.fn(),
  cleanup: vi.fn(),
  writeAudioChunk: vi.fn(),
}));
vi.mock("../sidecars", () => ({
  getLocalTranscriptionSidecarManager: () => mocks,
  isSessionNotFoundError: () => false,
}));
vi.mock("../actions/transcribe.actions", () => ({
  transcribeAudio: mocks.transcribeAudio,
}));
vi.mock("../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/user.utils")>()),
  loadMyEffectiveDictationLanguage: vi.fn(async () => "en"),
}));
vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: () => [],
  buildLocalizedTranscriptionPrompt: () => "",
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ info: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));

const samples = new Float32Array(16000).fill(0.1);
const response = {
  text: "thank you",
  model: "tiny",
  inferenceDevice: "CPU",
  durationMs: 12,
  segments: [{ text: "thank you", noSpeechProb: 0.99 }],
};
function setFilter(enabled: boolean) {
  setAppState({
    userPrefs: {
      ...createDefaultPreferences(),
      hallucinationFilterEnabled: enabled,
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  setFilter(true);
  mocks.transcribe.mockResolvedValue(response);
  mocks.finalize.mockResolvedValue(response);
  mocks.createStreamingSession.mockResolvedValue({
    finalize: mocks.finalize,
    cleanup: mocks.cleanup,
    writeAudioChunk: mocks.writeAudioChunk,
  });
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

describe("local batch transcription contracts", () => {
  it("honors the request opt-out rather than rereading the live preference", async () => {
    await new LocalTranscribeAudioRepo().transcribeAudio({
      samples,
      sampleRate: 16000,
      hallucinationFilterEnabled: false,
    });
    expect(mocks.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ hallucinationFilterEnabled: false }),
    );
  });
  it("retains probability metadata for the downstream filter", async () => {
    const output = await new LocalTranscribeAudioRepo().transcribeAudio({
      samples,
      sampleRate: 16000,
    });
    expect(output.segments).toEqual(response.segments);
    expect(gateSilentSegments(output.segments)).toBe("");
  });
  it("carries one opt-out through all provider chunks", async () => {
    class ShortLocalRepo extends LocalTranscribeAudioRepo {
      protected getSegmentDurationSec() {
        return 1;
      }
      protected getOverlapDurationSec() {
        return 0;
      }
    }
    await new ShortLocalRepo().transcribeAudio({
      samples: new Float32Array(32000).fill(0.1),
      sampleRate: 16000,
      hallucinationFilterEnabled: false,
    });
    expect(mocks.transcribe).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.transcribe.mock.calls)
      expect(request.hallucinationFilterEnabled).toBe(false);
  });
});

describe("local streaming filter ownership", () => {
  it.each([false, true])(
    "keeps a recording's disabled filter when the later preference is %s",
    async (later) => {
      setFilter(false);
      const session = new LocalTranscriptionSession();
      await session.onRecordingStart(16000);
      session.writeAudioChunk(new Float32Array([0.1, 0.2]), 0);
      expect(mocks.writeAudioChunk).toHaveBeenCalledWith(
        new Float32Array([0.1, 0.2]),
      );
      expect(mocks.createStreamingSession).toHaveBeenCalledWith(
        expect.objectContaining({ hallucinationFilterEnabled: false }),
      );
      setFilter(later);
      const output = await session.finalize({ samples, sampleRate: 16000 });
      expect(output.rawTranscript).toBe("thank you");
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps enabled silence filtering even when every segment is dropped", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16000);
    setFilter(false);
    expect(
      (await session.finalize({ samples, sampleRate: 16000 })).rawTranscript,
    ).toBeNull();
  });
  it("passes the recording opt-out to batch fallback after a streaming failure", async () => {
    setFilter(false);
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16000);
    setFilter(true);
    mocks.finalize.mockRejectedValueOnce(new Error("stream interrupted"));
    mocks.transcribeAudio.mockResolvedValueOnce({
      rawTranscript: "thank you",
      metadata: {},
      warnings: [],
    });
    expect(
      (await session.finalize({ samples, sampleRate: 16000 })).rawTranscript,
    ).toBe("thank you");
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ hallucinationFilterEnabled: false }),
    );
  });
  it("retains ONNX text when probability metadata is absent", async () => {
    mocks.finalize.mockResolvedValue({ ...response, segments: [] });
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16000);
    expect(
      (await session.finalize({ samples, sampleRate: 16000 })).rawTranscript,
    ).toBe("thank you");
  });
});

/**
 * The component owns the `audio_chunk` registration and hands each chunk to
 * `writeAudioChunk` with its absolute sample index. These cover the session
 * half of that contract: one chunk reaches both the sidecar stream and the
 * pause-chunked pretranscriber, and pretranscription only takes over at stop
 * when a span was actually committed.
 */
describe("local pause pretranscription wiring", () => {
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
  /** 25 s of speech clears the 24 s local minimum, then a 500 ms pause cuts. */
  const CUTTABLE = concat(speech(25, 1), silence(0.5, 2), speech(1, 3));
  const feed = (session: LocalTranscriptionSession, audio: Float32Array) => {
    for (let offset = 0; offset < audio.length; offset += 100) {
      session.writeAudioChunk(audio.subarray(offset, offset + 100), offset);
    }
  };
  const spanResult = (text: string) => ({
    sanitizedTranscript: text,
    rawTranscript: text,
    metadata: { transcriptionMode: "local", transcriptionDurationMs: 10 },
    warnings: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    // The fallback assertions read the sidecar's own text, so keep the
    // hallucination filter out of the way.
    setFilter(false);
    mocks.transcribe.mockResolvedValue(response);
    mocks.finalize.mockResolvedValue(response);
    mocks.createStreamingSession.mockResolvedValue({
      finalize: mocks.finalize,
      cleanup: mocks.cleanup,
      writeAudioChunk: mocks.writeAudioChunk,
    });
    mocks.transcribeAudio.mockResolvedValue(spanResult("span one"));
  });

  it("feeds one chunk to both the sidecar stream and the pretranscriber", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(RATE);

    session.writeAudioChunk(new Float32Array([0.1, 0.2]), 40);

    expect(mocks.writeAudioChunk).toHaveBeenCalledOnce();
    const forwarded = Array.from(
      mocks.writeAudioChunk.mock.calls[0][0] as Float32Array,
    );
    expect(forwarded[0]).toBeCloseTo(0.1, 5);
    expect(forwarded[1]).toBeCloseTo(0.2, 5);
  });

  it("pretranscribes a cuttable recording instead of the whole stream", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(RATE);
    feed(session, CUTTABLE);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.transcribeAudio).toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(result.rawTranscript).toContain("span one");
    expect(result.metadata.transcriptionMode).toBe("local");
  });

  it("falls back to the sidecar stream when the listener never fired", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(RATE);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(result.rawTranscript).toBe("thank you");
  });

  it("falls back when the live stream skipped samples", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(RATE);
    // A gap in the sample index must disable pretranscription rather than
    // produce a transcript of audio the sidecar never received.
    session.writeAudioChunk(CUTTABLE.subarray(0, 20_000), 0);
    session.writeAudioChunk(CUTTABLE.subarray(20_000, 26_000), 40_000);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(result.rawTranscript).toBe("thank you");
  });

  it("falls back when a span request fails", async () => {
    mocks.transcribeAudio.mockRejectedValue(new Error("provider 429"));
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(RATE);
    feed(session, CUTTABLE);

    const result = await session.finalize({
      samples: CUTTABLE,
      sampleRate: RATE,
    });

    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(result.rawTranscript).toBe("thank you");
  });

  it("releases the sidecar session and pretranscriber after finalize", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(RATE);
    feed(session, CUTTABLE);

    await session.finalize({ samples: CUTTABLE, sampleRate: RATE });
    session.writeAudioChunk(new Float32Array([0.1]), 999_999);

    expect(mocks.cleanup).toHaveBeenCalled();
  });
});
