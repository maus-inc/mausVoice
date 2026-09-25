import type { ApiKey, ApiKeyProvider } from "@maus-inc/types";
import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_APP_STATE, type AppState } from "../state/app.state";
import {
  isPostProcessingEnabled,
  isStyleSelectionAvailable,
} from "./post-processing.utils";

const makeApiKey = (
  provider: ApiKeyProvider = "groq",
  keyFull: string | null = "secret",
): ApiKey => ({
  id: "post-processing-key",
  name: "Post-processing",
  provider,
  createdAt: "2026-08-19T00:00:00.000Z",
  keyFull,
});

describe("isPostProcessingEnabled", () => {
  let state: AppState;

  beforeEach(() => {
    state = structuredClone(INITIAL_APP_STATE);
  });

  it("is disabled when the mode has not been configured", () => {
    expect(isPostProcessingEnabled(state)).toBe(false);
  });

  it("is disabled in off mode even when a valid provider is selected", () => {
    state.settings.aiPostProcessing.mode = "none";
    state.settings.aiPostProcessing.selectedApiKeyId = "post-processing-key";
    state.apiKeyById["post-processing-key"] = makeApiKey();

    expect(isPostProcessingEnabled(state)).toBe(false);
  });

  it("is disabled in API mode without a selected provider", () => {
    state.settings.aiPostProcessing.mode = "api";

    expect(isPostProcessingEnabled(state)).toBe(false);
  });

  it("is disabled in API mode when the selected provider is stale", () => {
    state.settings.aiPostProcessing.mode = "api";
    state.settings.aiPostProcessing.selectedApiKeyId = "missing-key";

    expect(isPostProcessingEnabled(state)).toBe(false);
  });

  it("is enabled in API mode with a configured provider key", () => {
    state.settings.aiPostProcessing.mode = "api";
    state.settings.aiPostProcessing.selectedApiKeyId = "post-processing-key";
    state.apiKeyById["post-processing-key"] = makeApiKey();

    expect(isPostProcessingEnabled(state)).toBe(true);
  });

  it.each(["ollama", "openai-compatible"] as const)(
    "supports the keyless %s provider just like the generation pipeline",
    (provider) => {
      state.settings.aiPostProcessing.mode = "api";
      state.settings.aiPostProcessing.selectedApiKeyId = "post-processing-key";
      state.apiKeyById["post-processing-key"] = makeApiKey(provider, null);

      expect(isPostProcessingEnabled(state)).toBe(true);
    },
  );
});

describe("isStyleSelectionAvailable", () => {
  let state: AppState;

  beforeEach(() => {
    state = structuredClone(INITIAL_APP_STATE);
  });

  it("is available even when post-processing is disabled (fast path)", () => {
    state.settings.aiPostProcessing.mode = "none";
    expect(isStyleSelectionAvailable(state)).toBe(true);
  });

  it("is available when tones exist", () => {
    state.toneById["default"] = {
      id: "default",
      name: "Polished",
      promptTemplate: "test",
      isSystem: true,
      createdAt: 0,
      sortOrder: 0,
    };
    expect(isStyleSelectionAvailable(state)).toBe(true);
  });
});
