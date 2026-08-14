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

// Make the Groq catch-all repo fail deterministically without touching the
// network. The real GroqTranscribeAudioRepo is loaded natively from the
// workspace-linked voice-ai package, so its inner SDK imports cannot be
// vi.mock'd; overriding just the class keeps the real dispatch logic (which
// generates the "no transcription implementation" warning) intact while the
// failing repo exercises the throw path under test.
vi.mock("../repos/transcribe-audio.repo", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../repos/transcribe-audio.repo")>();
  return {
    ...actual,
    GroqTranscribeAudioRepo: class {
      async transcribeAudio(): Promise<never> {
        throw new Error("mock groq transcription failure");
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
    transcriptionModel: null,
  };
  return state;
};

describe("transcribeAudio dispatch warnings on the failure path", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("logs dispatch warnings before the provider call and attaches them to the thrown error", async () => {
    setAppState(staleOllamaState(), true);

    await expect(
      transcribeAudio({
        samples: new Float32Array(16000),
        sampleRate: 16000,
      }),
    ).rejects.toThrow(
      /mock groq transcription failure.*No transcription implementation for provider "ollama"/s,
    );

    // The warning must reach the log even though the transcription call
    // itself throws (previously it was logged only after the await).
    expect(loggerMock.warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'No transcription implementation for provider "ollama"',
      ),
    );
  });
});
