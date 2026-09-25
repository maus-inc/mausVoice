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
  getModelStatus: vi.fn(),
  downloadModel: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("../sidecars", () => ({
  getLocalTranscriptionSidecarManager: () => mocks,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => mocks.unlisten),
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
  mocks.getModelStatus.mockResolvedValue({ downloaded: true, valid: true });
  mocks.transcribeAudio.mockResolvedValue({
    rawTranscript: "thank you",
    sanitizedTranscript: "thank you",
    metadata: { transcriptionMode: "local" },
    warnings: [],
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

describe("local filter ownership", () => {
  it.each([false, true])(
    "keeps a recording's disabled filter when the later preference is %s",
    async (later) => {
      setFilter(false);
      const session = new LocalTranscriptionSession();
      await session.onRecordingStart(16000);
      setFilter(later);
      const output = await session.finalize({ samples, sampleRate: 16000 });
      expect(output.rawTranscript).toBe("thank you");
      expect(mocks.unlisten).toHaveBeenCalledTimes(1);
      expect(mocks.transcribeAudio).toHaveBeenCalledWith(
        expect.objectContaining({ hallucinationFilterEnabled: false }),
      );
    },
  );
  it("transcribes nothing when the recording carries no audio", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16000);
    const output = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    expect(output.rawTranscript).toBeNull();
    expect(mocks.transcribeAudio).not.toHaveBeenCalled();
  });
  it("transcribes the whole recording when the model cannot be prepared", async () => {
    mocks.getModelStatus.mockRejectedValueOnce(
      new Error("sidecar unreachable"),
    );
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16000);
    const output = await session.finalize({ samples, sampleRate: 16000 });
    expect(output.rawTranscript).toBe("thank you");
    expect(output.warnings).toEqual([
      expect.stringContaining("Local pretranscription unavailable"),
    ]);
    expect(mocks.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});
