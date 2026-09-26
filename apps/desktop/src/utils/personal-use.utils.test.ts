import { describe, expect, expectTypeOf, it } from "vitest";
import type { DeepgramTranscriptionModel } from "@maus-inc/voice-ai";
import { getModelProviderRepo } from "../repos";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
  PERSONAL_GROQ_API_KEY_ID,
  resolvePersonalTranscriptionTarget,
} from "./personal-use.utils";

describe("PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL", () => {
  // Pins the value to the provider's own model union. Indexing a widened array
  // would silently produce `string | undefined`, which is assignable to the
  // optional update payload and would turn the write into a no-op.
  it("stays a non-nullable Deepgram model", () => {
    expectTypeOf(
      PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    ).toEqualTypeOf<DeepgramTranscriptionModel>();
  });

  // Asserts against the provider repo rather than the shared constant, because
  // the repo is what populates the model picker. Comparing the constant to the
  // array it was defined from would stay green even if the repo stopped
  // offering the model, which is the case this preset exists to prevent.
  it("is offered by the Deepgram provider that backs the picker", async () => {
    const offered = await getModelProviderRepo(
      "deepgram",
    ).getTranscriptionModels({});

    expect(offered).toContain(PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL);
  });
});

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

  it("selects the desired key from local mode", () => {
    const target = resolvePersonalTranscriptionTarget({
      deepgramKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
      groqKeyId: PERSONAL_GROQ_API_KEY_ID,
      currentMode: "local",
      currentApiKeyId: null,
    });

    expect(target).toEqual({
      mode: "api",
      apiKeyId: PERSONAL_DEEPGRAM_API_KEY_ID,
    });
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
