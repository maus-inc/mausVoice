import { describe, expect, expectTypeOf, it } from "vitest";
import type { ApiKey } from "@maus-inc/types";
import type { DeepgramTranscriptionModel } from "@maus-inc/voice-ai";
import { getModelProviderRepo } from "../repos";
import {
  PERSONAL_DEEPGRAM_API_KEY_ID,
  PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
  PERSONAL_GROQ_API_KEY_ID,
  PERSONAL_GROQ_API_KEY_NAME,
  PERSONAL_GROQ_POST_PROCESSING_MODEL,
  PERSONAL_GROQ_TRANSCRIPTION_MODEL,
  PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL,
  buildPersonalGroqKeyUpdate,
  resolvePersonalTranscriptionTarget,
} from "./personal-use.utils";

const personalGroqKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: PERSONAL_GROQ_API_KEY_ID,
  name: PERSONAL_GROQ_API_KEY_NAME,
  provider: "groq",
  createdAt: "2024-01-01T00:00:00.000Z",
  keyFull: "gsk_configured",
  transcriptionModel: PERSONAL_GROQ_TRANSCRIPTION_MODEL,
  postProcessingModel: PERSONAL_GROQ_POST_PROCESSING_MODEL,
  ...overrides,
});

describe("PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL", () => {
  // Pin the value itself. This and the repo check below read the same array, so
  // without a literal assertion a reorder or a different first entry would move
  // the preset and the expectation together and stay green.
  it("is Deepgram's current default model", () => {
    expect(PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL).toBe("nova-3");
  });

  // The preset must stay in the provider's own model union and must not become
  // nullable: `string | undefined` is assignable to the optional update
  // payload, so a widened array would silently turn the write into a no-op.
  // `toExtend` rather than `toEqualTypeOf`, because adding a second Deepgram
  // model widens that union, and a growing catalog is not a broken preset.
  it("stays a non-nullable Deepgram model", () => {
    expectTypeOf(
      PERSONAL_DEEPGRAM_TRANSCRIPTION_MODEL,
    ).toExtend<DeepgramTranscriptionModel>();
  });

  // Asserts against the provider repo rather than the shared constant, because
  // the repo is what populates the model picker. This covers the repo starting
  // to filter, or the picker reading its list from somewhere else.
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

describe("buildPersonalGroqKeyUpdate", () => {
  it("corrects only the fields that differ from the preset", () => {
    const update = buildPersonalGroqKeyUpdate(
      personalGroqKey({
        id: "adopted-key",
        name: "My Groq key",
        keyFull: "gsk_old",
        transcriptionModel: "a-model-someone-chose",
        postProcessingModel: null,
      }),
      "gsk_new",
    );

    expect(update).toEqual({
      id: "adopted-key",
      name: PERSONAL_GROQ_API_KEY_NAME,
      key: "gsk_new",
      postProcessingModel: PERSONAL_GROQ_POST_PROCESSING_MODEL,
    });
    // The deliberately chosen transcription model is not in the payload.
    expect(update).not.toHaveProperty("transcriptionModel");
  });

  it("returns the id alone when the stored key already matches", () => {
    const update = buildPersonalGroqKeyUpdate(
      personalGroqKey(),
      "gsk_configured",
    );

    expect(update).toEqual({ id: PERSONAL_GROQ_API_KEY_ID });
  });

  it("moves the model this app used to write forward, and nothing else", () => {
    const update = buildPersonalGroqKeyUpdate(
      personalGroqKey({
        transcriptionModel: PREVIOUS_PERSONAL_GROQ_TRANSCRIPTION_MODEL,
      }),
      "gsk_configured",
    );

    expect(update).toEqual({
      id: PERSONAL_GROQ_API_KEY_ID,
      transcriptionModel: PERSONAL_GROQ_TRANSCRIPTION_MODEL,
    });
  });
});
