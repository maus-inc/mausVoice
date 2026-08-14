import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { getTranscriptionPrefs } from "../utils/user.utils";

describe("transcribeAudio dispatch guard for unsupported providers", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("treats a stale Ollama selection as unselected (local mode + warning)", () => {
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
    setAppState(state, true);

    const prefs = getTranscriptionPrefs(getAppState());

    // The unsupported provider never reaches the transcription dispatch path:
    // prefs resolve to local mode with an explicit warning. (A configured Groq
    // key is deliberately not consulted here — Ollama cannot transcribe.)
    expect(prefs.mode).toBe("local");
    expect(prefs.warnings).toContain(
      "No transcription-capable API key selected.",
    );
  });
});
