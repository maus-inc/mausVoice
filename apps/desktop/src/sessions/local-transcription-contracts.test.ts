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
  createStreamingSession: vi.fn(),
  finalize: vi.fn(),
  cleanup: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("../sidecars", () => ({
  getLocalTranscriptionSidecarManager: () => mocks,
  isSessionNotFoundError: () => false,
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
  mocks.finalize.mockResolvedValue(response);
  mocks.createStreamingSession.mockResolvedValue({
    finalize: mocks.finalize,
    cleanup: mocks.cleanup,
    writeAudioChunk: vi.fn(),
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
      expect(mocks.createStreamingSession).toHaveBeenCalledWith(
        expect.objectContaining({ hallucinationFilterEnabled: false }),
      );
      setFilter(later);
      const output = await session.finalize({ samples, sampleRate: 16000 });
      expect(output.rawTranscript).toBe("thank you");
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
      expect(mocks.unlisten).toHaveBeenCalledTimes(1);
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

describe("local streaming start capture", () => {
  const emitChunk = (samples: number[]) => {
    const handler = vi.mocked(listen).mock.calls.at(-1)?.[1];
    handler?.({ event: "audio_chunk", id: 0, payload: { samples } });
  };

  it("delivers audio captured before the sidecar session exists, in order", async () => {
    const writeAudioChunk = vi.fn();
    let resolveSession: (value: unknown) => void = () => {};
    mocks.createStreamingSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    emitChunk([0.1, 0.2]);
    const starting = session.onRecordingStart(16000);
    emitChunk([0.3]);
    await vi.waitFor(() => expect(mocks.createStreamingSession).toBeCalled());
    resolveSession({
      finalize: mocks.finalize,
      cleanup: mocks.cleanup,
      writeAudioChunk,
    });
    await starting;
    emitChunk([0.4]);

    expect(listen).toHaveBeenCalledTimes(1);
    expect(writeAudioChunk.mock.calls).toEqual([
      [[0.1, 0.2]],
      [[0.3]],
      [[0.4]],
    ]);
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
    expect(mocks.createStreamingSession).toHaveBeenCalledTimes(1);
  });

  // The cap is 1.44M samples whatever the capture rate: 30 s at 48 kHz,
  // 90 s at 16 kHz.
  it.each([
    [48_000, 31],
    [16_000, 91],
  ])(
    "falls back to batch when startup audio outgrows the buffer at %i Hz",
    async (rate, seconds) => {
      const writeAudioChunk = vi.fn();
      const sidecarCleanup = vi.fn();
      mocks.createStreamingSession.mockResolvedValueOnce({
        finalize: mocks.finalize,
        cleanup: sidecarCleanup,
        writeAudioChunk,
      });
      mocks.transcribeAudio.mockResolvedValueOnce({
        rawTranscript: "the whole recording",
        metadata: {},
        warnings: [],
      });
      const session = new LocalTranscriptionSession();

      await session.onBeforeRecordingStart();
      const second = Array.from({ length: rate }, () => 0.1);
      for (let index = 0; index < seconds; index += 1) {
        emitChunk(second);
      }
      await session.onRecordingStart(rate);

      expect(writeAudioChunk).not.toHaveBeenCalled();
      expect(sidecarCleanup).toHaveBeenCalledTimes(1);
      const output = await session.finalize({ samples, sampleRate: rate });
      expect(output.rawTranscript).toBe("the whole recording");
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(output.warnings.join(" ")).toContain("falling back to batch mode");
    },
  );

  it("keeps a minute of 16 kHz startup audio, which is under the sample cap", async () => {
    const writeAudioChunk = vi.fn();
    mocks.createStreamingSession.mockResolvedValueOnce({
      finalize: mocks.finalize,
      cleanup: mocks.cleanup,
      writeAudioChunk,
    });
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    const second = Array.from({ length: 16_000 }, () => 0.1);
    for (let index = 0; index < 60; index += 1) {
      emitChunk(second);
    }
    await session.onRecordingStart(16_000);

    expect(writeAudioChunk).toHaveBeenCalledTimes(60);
  });

  it("releases the early listener on cleanup, before any sidecar session exists", async () => {
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    session.cleanup();

    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.createStreamingSession).not.toHaveBeenCalled();
  });

  it("keeps the start-time filter choice when the sidecar cannot start", async () => {
    setFilter(false);
    mocks.createStreamingSession.mockRejectedValueOnce(new Error("no model"));
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

  it("drops buffered audio and unsubscribes when the sidecar session cannot start", async () => {
    mocks.createStreamingSession.mockRejectedValueOnce(new Error("no model"));
    mocks.transcribeAudio.mockResolvedValueOnce({
      rawTranscript: "hello",
      metadata: {},
      warnings: [],
    });
    const session = new LocalTranscriptionSession();

    await session.onBeforeRecordingStart();
    emitChunk([0.1]);
    await session.onRecordingStart(16000);

    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    const output = await session.finalize({ samples, sampleRate: 16000 });
    expect(output.rawTranscript).toBe("hello");
    expect(mocks.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ samples: Array.from(samples) }),
    );
  });
});
