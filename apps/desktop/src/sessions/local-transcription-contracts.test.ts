import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
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

describe("local startup audio capture", () => {
  const emitChunk = (samples: number[], offset: number) => {
    const handler = vi.mocked(listen).mock.calls.at(-1)?.[1];
    handler?.({
      event: "audio_chunk",
      id: 0,
      payload: { samples, offset },
    });
  };

  it("delivers audio captured before the pretranscriber exists, in order, with its index", async () => {
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    emitChunk([0.1, 0.2], 0);
    const starting = session.onRecordingStart(16000);
    emitChunk([0.3], 2);
    await starting;
    emitChunk([0.4], 3);

    // One registration, and no chunk is left stranded in the startup buffer
    // once the pretranscriber owns the stream.
    expect(listen).toHaveBeenCalledTimes(1);
    await session.finalize({ samples, sampleRate: 16000 });
    expect(mocks.transcribeAudio).toHaveBeenCalled();
  });

  it("still subscribes when recording starts without the early hook", async () => {
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16000);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("retries the subscription at start when the early hook could not subscribe", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("ipc unavailable"));
    const session = new LocalTranscriptionSession();

    await expect(session.onBeforeRecordingStart()).resolves.toBeUndefined();
    await session.onRecordingStart(16000);

    expect(listen).toHaveBeenCalledTimes(2);
  });

  // The cap is 1.44M samples whatever the capture rate: 30 s at 48 kHz,
  // 90 s at 16 kHz.
  it.each([
    [48_000, 31],
    [16_000, 91],
  ])(
    "falls back to the whole recording when startup audio outgrows the buffer at %i Hz",
    async (rate, seconds) => {
      mocks.transcribeAudio.mockResolvedValueOnce({
        rawTranscript: "the whole recording",
        metadata: {},
        warnings: [],
      });
      const session = new LocalTranscriptionSession();

      await session.onBeforeRecordingStart();
      const second = Array.from({ length: rate }, () => 0.1);
      let offset = 0;
      for (let index = 0; index < seconds; index += 1) {
        emitChunk(second, offset);
        offset += rate;
      }
      await session.onRecordingStart(rate);

      const output = await session.finalize({ samples, sampleRate: rate });
      expect(output.rawTranscript).toBe("the whole recording");
      expect(mocks.transcribeAudio).toHaveBeenCalledWith(
        expect.objectContaining({ samples }),
      );
    },
  );

  it("keeps a minute of 16 kHz startup audio, which is under the sample cap", async () => {
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    const second = Array.from({ length: 16_000 }, () => 0.1);
    let offset = 0;
    for (let index = 0; index < 60; index += 1) {
      emitChunk(second, offset);
      offset += 16_000;
    }
    await session.onRecordingStart(16_000);

    // Under the cap, so the pretranscriber takes over and the recording is
    // covered by spans rather than the whole-recording request.
    mocks.transcribeAudio.mockResolvedValueOnce({
      rawTranscript: "spans",
      metadata: {},
      warnings: [],
    });
    await session.finalize({ samples, sampleRate: 16_000 });
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ samples }),
    );
  });

  it("releases the early listener on cleanup, before the pretranscriber exists", async () => {
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    session.cleanup();

    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps the start-time filter choice when pretranscription cannot start", async () => {
    setFilter(false);
    vi.mocked(listen).mockRejectedValue(new Error("ipc unavailable"));
    mocks.transcribeAudio.mockResolvedValueOnce({
      rawTranscript: "hello",
      metadata: {},
      warnings: [],
    });
    const session = new LocalTranscriptionSession();

    await session.onRecordingStart(16000);
    setFilter(true);
    await session.finalize({ samples, sampleRate: 16000 });

    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ hallucinationFilterEnabled: false }),
    );
  });
});
