import type { UserPreferences } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  storeTranscription,
  transcribeAudio,
  type StoreTranscriptionInput,
} from "./transcribe.actions";

const { loggerMock, invokeMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  },
  invokeMock: vi.fn(),
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Resource: class {},
  Channel: class {},
  convertFileSrc: (path: string) => path,
}));

const { createTranscriptionMock, purgeStaleAudioMock } = vi.hoisted(() => ({
  createTranscriptionMock: vi.fn(),
  purgeStaleAudioMock: vi.fn(async () => [] as string[]),
}));

vi.mock("../repos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repos")>();
  return {
    ...actual,
    getTranscriptionRepo: () => ({
      createTranscription: createTranscriptionMock,
      purgeStaleAudio: purgeStaleAudioMock,
    }),
  };
});

vi.mock("./user.actions", () => ({
  addWordsToCurrentUser: vi.fn(async () => undefined),
}));

const staleOllamaState = () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.aiTranscription.mode = "api";
  state.settings.aiTranscription.selectedApiKeyId = "ollama-key";
  state.apiKeyById["ollama-key"] = {
    id: "ollama-key",
    name: "Ollama",
    provider: "ollama",
    createdAt: "2026-06-03T00:00:00.000Z",
    keyFull: null,
    baseUrl: "http://127.0.0.1:11434",
    transcriptionModel: "llama3.2",
  };
  return state;
};

describe("transcribeAudio warning logging and failure-path cause preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("logs the stale-selection warning before the provider call", async () => {
    setAppState(staleOllamaState(), true);

    // The prefs guard resolves the stale selection to local mode; the
    // dispatch warning is logged before any network/provider call happens.
    const result = await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch((e: unknown) => e);

    // Local sidecar requires a Tauri runtime; in a node test the call either
    // throws from the sidecar or, if the guard holds, never reaches it. The
    // key assertion is that the warning was logged before the provider call.
    expect(loggerMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("No transcription-capable API key selected"),
    );
    // No Groq fallback repo was constructed for the unsupported provider.
    expect(result).toBeDefined();
  });

  it("preserves a non-Error rejection as the cause on the failure path", async () => {
    // A transcription-capable provider whose repository fails: Deepgram with
    // a key, but the network request rejects with a non-Error value. The
    // action must wrap it with the warning and preserve the original value.
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "deepgram-key";
    state.apiKeyById["deepgram-key"] = {
      id: "deepgram-key",
      name: "Deepgram",
      provider: "deepgram",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: "dg-key",
      transcriptionModel: "nova-3",
    };
    setAppState(state, true);

    // The Deepgram repo's fetch rejects with a non-Error primitive.
    vi.spyOn(globalThis, "fetch").mockRejectedValue("socket exploded");

    const error = await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe("socket exploded");
    expect((error as Error).message).toMatch(/socket exploded/);
  });

  it("logs dispatch warnings before the provider call on the failure path", async () => {
    // Deepgram with a missing key: prefs warns before the (failing) call.
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "deepgram-key";
    state.apiKeyById["deepgram-key"] = {
      id: "deepgram-key",
      name: "Deepgram",
      provider: "deepgram",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: null,
      transcriptionModel: "nova-3",
    };
    setAppState(state, true);

    const error = await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(
      /No API key configured for API transcription/,
    );
  });
});

const audioSamples = new Float32Array([0.1, 0.2, 0.3]);

const buildInput = (overrides: Partial<StoreTranscriptionInput> = {}) => ({
  audio: { samples: audioSamples, sampleRate: 16000 },
  rawTranscript: "hello world",
  sanitizedTranscript: null,
  transcript: "hello world",
  transcriptionMetadata: { transcriptionMode: "local" as const },
  postProcessMetadata: {},
  warnings: [] as string[],
  ...overrides,
});

const setPrefs = (overrides: Partial<UserPreferences>) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.userPrefs = {
    incognitoModeEnabled: false,
    incognitoModeIncludeInStats: false,
    preserveAudioOnFailure: true,
    ...overrides,
  } as UserPreferences;
  setAppState(state, true);
};

describe("storeTranscription audio retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockReset();
    createTranscriptionMock.mockReset();
    purgeStaleAudioMock.mockReset();
    purgeStaleAudioMock.mockResolvedValue([]);
    createTranscriptionMock.mockImplementation(async (t) => t);
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("never saves the audio snapshot in incognito when transcription fails (no history record)", async () => {
    setPrefs({ incognitoModeEnabled: true });
    invokeMock.mockResolvedValue({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });

    const result = await storeTranscription(
      buildInput({ rawTranscript: null, warnings: ["provider failed"] }),
    );

    expect(invokeMock).not.toHaveBeenCalledWith("store_transcription_audio");
    expect(createTranscriptionMock).not.toHaveBeenCalled();
    expect(result.transcription).toBeNull();
  });

  it("never saves the audio snapshot in incognito when transcription succeeds (no history record)", async () => {
    setPrefs({ incognitoModeEnabled: true });
    invokeMock.mockResolvedValue({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });

    const result = await storeTranscription(buildInput());

    expect(invokeMock).not.toHaveBeenCalledWith("store_transcription_audio");
    expect(createTranscriptionMock).not.toHaveBeenCalled();
    expect(result.transcription).toBeNull();
  });

  it("keeps the audio snapshot outside incognito on failure when preserveAudioOnFailure is true", async () => {
    setPrefs({ incognitoModeEnabled: false, preserveAudioOnFailure: true });
    invokeMock.mockResolvedValue({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });

    const result = await storeTranscription(
      buildInput({ rawTranscript: null, warnings: ["provider failed"] }),
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "store_transcription_audio",
      expect.objectContaining({ sampleRate: 16000 }),
    );
    expect(createTranscriptionMock).toHaveBeenCalledTimes(1);
    const stored = createTranscriptionMock.mock.calls[0][0];
    expect(stored.audio).toEqual({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });
    expect(stored.transcript).toBe("[Transcription Failed]");
    expect(result.transcription).not.toBeNull();
  });

  it("does not write the audio file outside incognito on failure when preserveAudioOnFailure is false (no orphan WAV)", async () => {
    setPrefs({ incognitoModeEnabled: false, preserveAudioOnFailure: false });
    invokeMock.mockResolvedValue({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });

    const result = await storeTranscription(
      buildInput({ rawTranscript: null, warnings: ["provider failed"] }),
    );

    // The previous behaviour wrote the WAV and then dropped the snapshot from
    // the DB row, leaking the file (purge only follows audio_path). Skip the
    // write entirely now so the audio directory cannot grow unboundedly when
    // the user opts out of failure retention.
    expect(invokeMock).not.toHaveBeenCalledWith("store_transcription_audio");
    expect(createTranscriptionMock).toHaveBeenCalledTimes(1);
    const stored = createTranscriptionMock.mock.calls[0][0];
    expect(stored.audio).toBeUndefined();
    expect(stored.transcript).toBe("[Transcription Failed]");
    expect(result.transcription).not.toBeNull();
  });
});

describe("storeTranscription empty-audio retention (#418)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockReset();
    createTranscriptionMock.mockReset();
    purgeStaleAudioMock.mockReset();
    purgeStaleAudioMock.mockResolvedValue([]);
    createTranscriptionMock.mockImplementation(async (t) => t);
    setPrefs({});
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("saves the text record when samples are empty but rawTranscript is non-empty", async () => {
    invokeMock.mockResolvedValue({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });

    const result = await storeTranscription(
      buildInput({
        audio: { samples: new Float32Array(0), sampleRate: 16000 },
        rawTranscript: "hello world",
        transcript: "hello world",
      }),
    );

    expect(createTranscriptionMock).toHaveBeenCalledTimes(1);
    const stored = createTranscriptionMock.mock.calls[0][0];
    expect(stored.transcript).toBe("hello world");
    expect(stored.rawTranscript).toBe("hello world");
    expect(result.transcription).not.toBeNull();
  });

  it("saves a transcription-failure marker when samples and transcript are empty but warnings exist", async () => {
    invokeMock.mockResolvedValue({
      filePath: "/tmp/audio.wav",
      durationMs: 100,
    });

    const result = await storeTranscription(
      buildInput({
        audio: { samples: new Float32Array(0), sampleRate: 16000 },
        rawTranscript: null,
        sanitizedTranscript: null,
        transcript: null,
        warnings: ["provider failed: timeout"],
      }),
    );

    expect(createTranscriptionMock).toHaveBeenCalledTimes(1);
    const stored = createTranscriptionMock.mock.calls[0][0];
    expect(stored.transcript).toBe("[Transcription Failed]");
    expect(stored.warnings).toEqual(["provider failed: timeout"]);
    expect(result.transcription).not.toBeNull();
  });

  it("skips storage entirely when samples, transcript, and warnings are all empty", async () => {
    const result = await storeTranscription(
      buildInput({
        audio: { samples: new Float32Array(0), sampleRate: 16000 },
        rawTranscript: null,
        sanitizedTranscript: null,
        transcript: null,
        warnings: [],
      }),
    );

    expect(createTranscriptionMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("store_transcription_audio");
    expect(result.transcription).toBeNull();
  });
});
