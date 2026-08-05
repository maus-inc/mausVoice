import { describe, expect, it } from "vitest";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_ID,
  resolvePersonalTranscriptionTarget,
} from "./personal-use.utils";

describe("resolvePersonalTranscriptionTarget", () => {
  it("selects Personal Deepgram when both keys are present", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: PERSONAL_GROQ_API_KEY_ID,
      currentMode: null,
      currentApiKeyId: null,
    });

    expect(target).toEqual({
      mode: "api",
      apiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
    });
  });

  it("falls back to Personal Groq when Deepgram is missing", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: null,
      groqKeyId: PERSONAL_GROQ_API_KEY_ID,
      currentMode: null,
      currentApiKeyId: null,
    });

    expect(target).toEqual({ mode: "api", apiKeyId: PERSONAL_GROQ_API_KEY_ID });
  });

  it("selects Personal Deepgram when only Deepgram is present (no Groq)", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: null,
      currentMode: null,
      currentApiKeyId: null,
    });

    expect(target).toEqual({
      mode: "api",
      apiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
    });
  });

  it("migrates an existing Personal Groq selection to Personal Deepgram", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: PERSONAL_GROQ_API_KEY_ID,
      currentMode: "api",
      currentApiKeyId: PERSONAL_GROQ_API_KEY_ID,
    });

    expect(target).toEqual({
      mode: "api",
      apiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
    });
  });

  it("migrates an adopted noncanonical Groq id (matched by discovered key)", () => {
    const adoptedGroqId = "groq-adopted-123";
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: adoptedGroqId,
      currentMode: "api",
      currentApiKeyId: adoptedGroqId,
    });

    expect(target).toEqual({
      mode: "api",
      apiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
    });
  });

  it("preserves an unrelated user-selected transcription key", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: PERSONAL_GROQ_API_KEY_ID,
      currentMode: "api",
      currentApiKeyId: "user-elevenlabs-key",
    });

    expect(target).toBeNull();
  });

  it("is idempotent when Personal Deepgram is already selected", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: PERSONAL_GROQ_API_KEY_ID,
      currentMode: "api",
      currentApiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
    });

    expect(target).toBeNull();
  });

  it("selects the desired key from cloud or local modes", () => {
    for (const currentMode of ["cloud", "local"] as const) {
      const target = resolvePersonalTranscriptionTarget({
        deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
        groqKeyId: PERSONAL_GROQ_API_KEY_ID,
        currentMode,
        currentApiKeyId: null,
      });

      expect(target).toEqual({
        mode: "api",
        apiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      });
    }
  });

  it("returns null when no personal key exists", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: null,
      groqKeyId: null,
      currentMode: null,
      currentApiKeyId: null,
    });

    expect(target).toBeNull();
  });
});
