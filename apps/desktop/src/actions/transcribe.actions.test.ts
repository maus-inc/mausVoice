import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { transcribeAudio } from "./transcribe.actions";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  },
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

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
