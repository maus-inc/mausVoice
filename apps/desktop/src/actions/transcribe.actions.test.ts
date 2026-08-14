import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { transcribeAudio } from "./transcribe.actions";

const { loggerMock, failureValue, constructedGroqRepos } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  },
  failureValue: { current: new Error("mock groq transcription failure") } as {
    current: unknown;
  },
  constructedGroqRepos: [] as Array<{ apiKey: string; model: string | null }>,
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

// Make the Groq catch-all repo fail deterministically without touching the
// network. The real GroqTranscribeAudioRepo is loaded natively from the
// workspace-linked voice-ai package, so its inner SDK imports cannot be
// vi.mock'd; overriding just the class keeps the real dispatch logic (which
// generates the "no transcription implementation" warning) intact while the
// failing repo exercises the throw path under test. Capturing the constructor
// arguments lets the test assert which key/model the fallback uses.
vi.mock("../repos/transcribe-audio.repo", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../repos/transcribe-audio.repo")>();
  return {
    ...actual,
    GroqTranscribeAudioRepo: class {
      constructor(apiKey: string, model: string | null) {
        constructedGroqRepos.push({ apiKey, model });
      }
      async transcribeAudio(): Promise<never> {
        throw failureValue.current;
      }
    },
  };
});

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
  // The stale selection falls back to Groq; a configured Groq key must be
  // present for the fallback to be constructed with valid credentials. The
  // stale Ollama record carries its own (non-Groq) model to prove the
  // fallback uses the Groq record's model instead.
  state.apiKeyById["groq-key"] = {
    id: "groq-key",
    name: "Groq",
    provider: "groq",
    createdAt: "2026-06-03T00:00:00.000Z",
    keyFull: "gq-key",
    transcriptionModel: "whisper-large-v3",
  };
  return state;
};

describe("transcribeAudio dispatch warnings on the failure path", () => {
  beforeEach(() => {
    constructedGroqRepos.length = 0;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    failureValue.current = new Error("mock groq transcription failure");
    vi.clearAllMocks();
    constructedGroqRepos.length = 0;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("logs dispatch warnings before the provider call and preserves the Error cause", async () => {
    setAppState(staleOllamaState(), true);

    const error = await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /mock groq transcription failure.*No transcription implementation for provider "ollama"/s,
    );
    // The original Error rejection is preserved verbatim as the cause.
    expect((error as Error).cause).toBe(failureValue.current);

    // The warning must reach the log even though the transcription call
    // itself throws (previously it was logged only after the await).
    expect(loggerMock.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'No transcription implementation for provider "ollama"',
      ),
    );
  });

  it("preserves non-Error rejections as the cause", async () => {
    failureValue.current = "boom";
    setAppState(staleOllamaState(), true);

    const error = await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(
      /boom.*No transcription implementation for provider "ollama"/s,
    );
    // A non-Error rejection is kept as-is (not wrapped in an Error).
    expect((error as Error).cause).toBe("boom");
  });

  it("builds the Groq fallback with the Groq record's own key and model", async () => {
    setAppState(staleOllamaState(), true);

    await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch(() => undefined);

    // The stale Ollama selection carries transcriptionModel "llama3.2", but
    // the fallback must use the Groq record's model (and key), never a model
    // that belongs to another provider.
    expect(constructedGroqRepos).toHaveLength(1);
    expect(constructedGroqRepos[0]).toEqual({
      apiKey: "gq-key",
      model: "whisper-large-v3",
    });
  });

  it("fails with a clear configuration error when no Groq key backs the fallback", async () => {
    // Only the stale Ollama key exists; the dispatch has no valid fallback
    // credentials and must not construct a Groq repo with an empty key.
    const state = staleOllamaState();
    delete state.apiKeyById["groq-key"];
    setAppState(state, true);

    const error = await transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
    }).catch((e: unknown) => e);

    expect((error as Error).message).toMatch(
      /No transcription implementation for provider "ollama" and no Groq API key is configured/,
    );
  });
});
