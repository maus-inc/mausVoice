import { describe, expect, it } from "vitest";
import { getProviderFormConfig } from "./api-key-provider-config";

describe("getProviderFormConfig", () => {
  it("includes a transcription model field for AssemblyAI", () => {
    const config = getProviderFormConfig("assemblyai", "transcription");
    const modelField = config.fields.find(
      (field) => field.key === "transcriptionModel",
    );

    expect(modelField).toBeDefined();
    expect(modelField?.required).toBe(false);
  });

  it("keeps the API key required for AssemblyAI", () => {
    const config = getProviderFormConfig("assemblyai", "transcription");
    const apiKeyField = config.fields.find((field) => field.key === "apiKey");

    expect(apiKeyField?.required).toBe(true);
  });

  it("does not add a transcription model field to providers without one", () => {
    const config = getProviderFormConfig("elevenlabs", "transcription");

    expect(
      config.fields.some((field) => field.key === "transcriptionModel"),
    ).toBe(false);
  });
});
