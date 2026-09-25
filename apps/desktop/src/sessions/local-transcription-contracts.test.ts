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
      session.writeAudioChunk(new Float32Array([0.1, 0.2]));
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
