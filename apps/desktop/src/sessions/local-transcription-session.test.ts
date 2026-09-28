import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { createDefaultPreferences } from "../actions/user.actions";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import { LocalTranscriptionSession } from "./local-transcription-session";
import { openAudioChunkStreamFor } from "../../test/helpers/audio-chunk-relay";
import { MAX_BUFFERED_SAMPLES } from "./recording-audio-relay";

const mocks = vi.hoisted(() => ({
  transcribeAudio: vi.fn(),
  getModelStatus: vi.fn(),
  downloadModel: vi.fn(),
  unlisten: vi.fn(),
  listen: vi.fn(),
  order: [] as string[],
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../actions/transcribe.actions", () => ({
  transcribeAudio: mocks.transcribeAudio,
}));
vi.mock("../sidecars", () => ({
  getLocalTranscriptionSidecarManager: () => ({
    getModelStatus: mocks.getModelStatus,
    downloadModel: mocks.downloadModel,
  }),
}));
vi.mock("../utils/user.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/user.utils")>()),
  loadMyEffectiveDictationLanguage: vi.fn(async () => "en"),
}));
vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: () => [],
  buildLocalizedTranscriptionPrompt: () => "mausvoice",
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

const RATE = 1_000;
const MODEL = "base";

/** Speech-like noise at ~0.4 RMS, or near-silence, with a unique seed. */
const segment = (seconds: number, speech: boolean, seed: number) => {
  const samples = new Float32Array(Math.round(RATE * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    const phase = Math.sin(index * 0.7 + seed);
    samples[index] = speech ? 0.4 * phase : 0.0005 * phase;
  }
  return samples;
};

const join = (...parts: Float32Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

/** Longer than the 24 s local minimum, so at least one span is cut. */
const recording = join(
  segment(30, true, 1),
  segment(0.6, false, 2),
  segment(30, true, 3),
  segment(0.6, false, 4),
  segment(10, true, 5),
);

const chunkListener = (): ((samples: number[], offset: number) => void) => {
  const handler = mocks.listen.mock.calls.at(-1)?.[1] as
    | ((event: { payload: { samples: number[]; offset: number } }) => void)
    | undefined;
  if (!handler) throw new Error("no audio_chunk listener was registered");
  return (samples, offset) => handler({ payload: { samples, offset } });
};

/** Streams `audio` in 100-sample frames, the way the recorder emits it. */
const streamRecording = (audio: Float32Array, from = 0, to = audio.length) => {
  const emit = chunkListener();
  for (let offset = from; offset < to; offset += 100) {
    emit(
      Array.from(audio.subarray(offset, Math.min(offset + 100, to))),
      offset,
    );
  }
};

/**
 * Registers the session's chunk stream and starts it, the order a capture
 * entry point uses. `whileStarting` stands in for the user speaking before the
 * session has finished preparing.
 */
const startSession = async (
  session: LocalTranscriptionSession,
  whileStarting?: () => void,
) => {
  await openAudioChunkStreamFor(session);
  const starting = session.onRecordingStart(RATE);
  whileStarting?.();
  await starting;
};

const spanResult = (samples: Float32Array) => ({
  rawTranscript: `raw ${samples.length}`,
  sanitizedTranscript: `span of ${samples.length}`,
  metadata: { modelSize: MODEL, transcriptionDurationMs: 100 },
  warnings: [],
});

/** Samples handed to the provider, in request order. */
const requestedAudio = (): number[] =>
  mocks.transcribeAudio.mock.calls.map(
    (call) => (call[0] as { samples: Float32Array }).samples.length,
  );

let modelStatus: { downloaded: boolean; valid: boolean };

const setFilter = (enabled: boolean) => {
  setAppState({
    userPrefs: {
      ...createDefaultPreferences(),
      hallucinationFilterEnabled: enabled,
    },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  setFilter(true);
  modelStatus = { downloaded: true, valid: true };
  mocks.listen.mockImplementation(async () => {
    mocks.order.push("listen");
    return mocks.unlisten;
  });
  mocks.getModelStatus.mockImplementation(async () => {
    mocks.order.push("getModelStatus");
    return modelStatus;
  });
  mocks.downloadModel.mockImplementation(async () => {
    mocks.order.push("downloadModel");
    return { downloaded: true, valid: true };
  });
  mocks.transcribeAudio.mockImplementation(async ({ samples }) => {
    mocks.order.push("transcribe");
    return spanResult(samples);
  });
});

describe("LocalTranscriptionSession pretranscription wiring", () => {
  it("holds the registered chunk stream until cleanup releases it", async () => {
    const session = new LocalTranscriptionSession();
    await startSession(session);
    expect(mocks.listen).toHaveBeenCalledWith(
      "audio_chunk",
      expect.any(Function),
    );
    expect(mocks.unlisten).not.toHaveBeenCalled();

    session.cleanup();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
    // The relay belongs to the recording, so a re-armed scope keeps the stream
    // and only the session's own teardown releases it.
    await startSession(session);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps the chunk stream open while it prepares the model", async () => {
    const session = new LocalTranscriptionSession();
    await startSession(session);
    const settings = INITIAL_APP_STATE.settings.aiTranscription;

    expect(mocks.getModelStatus).toHaveBeenCalledWith({
      model: normalizeLocalWhisperModel(settings.modelSize),
      preferGpu: isGpuPreferredTranscriptionDevice(settings.device),
    });
    expect(mocks.downloadModel).not.toHaveBeenCalled();
    // The stream is registered before the session starts, so the model
    // download runs with the listener already holding the user's audio.
    expect(mocks.order).toEqual(["listen", "getModelStatus"]);
    expect(mocks.unlisten).not.toHaveBeenCalled();
  });

  it("downloads a missing model while the user is still speaking", async () => {
    modelStatus = { downloaded: false, valid: false };
    const session = new LocalTranscriptionSession();
    await startSession(session);

    expect(mocks.downloadModel).toHaveBeenCalledTimes(1);
    expect(mocks.order).toEqual(["listen", "getModelStatus", "downloadModel"]);
  });

  it("delivers the whole recording a model download was running behind", async () => {
    modelStatus = { downloaded: false, valid: false };
    let finishDownload = () => {};
    const downloading = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    mocks.downloadModel.mockImplementation(async () => {
      await downloading;
      return { downloaded: true, valid: true };
    });
    const session = new LocalTranscriptionSession();
    await openAudioChunkStreamFor(session);
    const starting = session.onRecordingStart(RATE);
    // The first run: the user speaks through the whole download.
    streamRecording(recording, 0, 30_000);
    finishDownload();
    await starting;
    streamRecording(recording, 30_000);

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });
    const lengths = requestedAudio();

    // Spans cover the download as well as the rest, so the recording never
    // fell back to a single whole-recording request.
    expect(lengths.length).toBeGreaterThan(1);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(
      recording.length,
    );
    expect(result.rawTranscript).toBe(
      lengths.map((length) => `span of ${length}`).join(" "),
    );
  });

  it("transcribes each span once and never the whole recording", async () => {
    const session = new LocalTranscriptionSession();
    await startSession(session);
    streamRecording(recording);

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });
    const lengths = requestedAudio();

    expect(result.rawTranscript).toBe(
      lengths.map((length) => `span of ${length}`).join(" "),
    );
    expect(result.metadata.transcriptionMode).toBe("local");
    expect(result.metadata.transcriptionPrompt).toBe("mausvoice");
    // The spans tile the recording exactly once: one inference pass, no
    // second pass over the same audio.
    expect(lengths.length).toBeGreaterThan(1);
    expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(
      recording.length,
    );
    expect(lengths).not.toContain(recording.length);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("transcribes the whole recording when no span was cut", async () => {
    const short = join(segment(10, true, 1), segment(10, true, 2));
    const session = new LocalTranscriptionSession();
    await startSession(session);
    streamRecording(short);

    const result = await session.finalize({ samples: short, sampleRate: RATE });

    expect(requestedAudio()).toEqual([short.length]);
    expect(result.rawTranscript).toBe(`raw ${short.length}`);
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps a recording's filter snapshot for every span and the whole recording", async () => {
    setFilter(false);
    const session = new LocalTranscriptionSession();
    await startSession(session);
    streamRecording(recording);
    // The user re-enables the filter while still speaking.
    setFilter(true);

    await session.finalize({ samples: recording, sampleRate: RATE });
    expect(mocks.transcribeAudio).toHaveBeenCalled();
    for (const [input] of mocks.transcribeAudio.mock.calls)
      expect(input.hallucinationFilterEnabled).toBe(false);
  });

  it("keeps an empty filtered span instead of reviving dropped segments", async () => {
    mocks.transcribeAudio.mockResolvedValue({
      rawTranscript: "   ",
      sanitizedTranscript: "",
      metadata: {},
      warnings: [],
    });
    const session = new LocalTranscriptionSession();
    await startSession(session);
    streamRecording(recording);

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });

    expect(result.rawTranscript).toBeNull();
  });

  it("spends no further request when a cancel lands mid-finalize", async () => {
    const session = new LocalTranscriptionSession();
    await startSession(session);
    streamRecording(recording);

    let releaseTail = () => {};
    const tailInFlight = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    // The committed spans answer immediately; the tail parks so the cancel
    // below lands while the last span request is still open.
    let requests = 0;
    mocks.transcribeAudio.mockImplementation(async ({ samples }) => {
      requests += 1;
      if (requests < 3) return spanResult(samples);
      await tailInFlight;
      return spanResult(samples);
    });

    const pending = session.finalize({ samples: recording, sampleRate: RATE });
    await vi.waitFor(() => expect(requests).toBe(3));
    session.cleanup();
    releaseTail();

    const result = await pending;
    expect(result.rawTranscript).toBeNull();
    expect(mocks.transcribeAudio).toHaveBeenCalledTimes(3);
    expect(requestedAudio()).not.toContain(recording.length);
  });

  it("records the whole recording when the capture entry point registered no chunk stream", async () => {
    const session = new LocalTranscriptionSession();
    await expect(session.onRecordingStart(RATE)).resolves.toBeUndefined();

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });

    expect(result.warnings).toEqual([
      expect.stringContaining("Local pretranscription unavailable"),
    ]);
    expect(result.rawTranscript).toBe(`raw ${recording.length}`);
    expect(requestedAudio()).toEqual([recording.length]);
  });

  it("records the whole recording when the relay overflowed before the session bound", async () => {
    const session = new LocalTranscriptionSession();
    await openAudioChunkStreamFor(session);
    // More audio than the relay holds, which is what a model download longer
    // than its buffer looks like.
    streamRecording(new Float32Array(MAX_BUFFERED_SAMPLES + 1).fill(0.1));
    await expect(session.onRecordingStart(RATE)).resolves.toBeUndefined();

    const result = await session.finalize({
      samples: recording,
      sampleRate: RATE,
    });

    expect(result.warnings).toEqual([
      expect.stringContaining("Local pretranscription unavailable"),
    ]);
    expect(result.rawTranscript).toBe(`raw ${recording.length}`);
    expect(requestedAudio()).toEqual([recording.length]);
  });
});
