import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above module-level consts, so the fakes must be created
// inside vi.hoisted to exist by the time the factory runs.
const { secureFetch, createOpenAICompatibleFetch } = vi.hoisted(() => ({
  secureFetch: vi.fn(),
  createOpenAICompatibleFetch: vi.fn(() => vi.fn()),
}));

vi.mock("../../utils/secure-fetch.utils", () => ({
  secureFetch,
  createOpenAICompatibleFetch,
}));

vi.mock("@maus-inc/voice-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@maus-inc/voice-ai")>();
  const spied = { ...actual } as Record<string, unknown>;
  for (const name of Object.keys(actual)) {
    if (name.endsWith("TestIntegration")) {
      spied[name] = vi.fn().mockResolvedValue(true);
    }
  }
  return spied;
});

import * as voiceAi from "@maus-inc/voice-ai";
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

describe("provider test-integration transport", () => {
  const key = (over: Record<string, unknown> = {}) =>
    ({
      id: "key-1",
      keyFull: "secret",
      baseUrl: "https://example.test",
      azureRegion: "eastus",
      transcriptionModel: null,
      ...over,
    }) as Parameters<
      ReturnType<typeof getProviderFormConfig>["testIntegration"]
    >[0];

  // Browser fetch would subject these to provider CORS while sending
  // non-simple auth headers, so the Test button could fail while dictation
  // still worked. Every provider whose helper accepts customFetch must be
  // handed the native transport.
  it.each([
    ["groq", "groqTestIntegration"],
    ["openai", "openaiTestIntegration"],
    ["elevenlabs", "elevenlabsTestIntegration"],
    ["deepseek", "deepseekTestIntegration"],
    ["assemblyai", "assemblyaiTestIntegration"],
  ])("%s routes through secureFetch", async (provider, fnName) => {
    const spy = vi.mocked(
      (voiceAi as unknown as Record<string, ReturnType<typeof vi.fn>>)[fnName]!,
    );
    spy.mockClear();

    await getProviderFormConfig(
      provider as Parameters<typeof getProviderFormConfig>[0],
      "transcription",
    ).testIntegration(key(), "transcription");

    expect(spy.mock.calls[0]![0]).toMatchObject({ customFetch: secureFetch });
  });

  it("openai-compatible routes through the saved-endpoint transport", async () => {
    const spy = vi.mocked(voiceAi.openaiCompatibleTestIntegration);
    spy.mockClear();
    createOpenAICompatibleFetch.mockClear();

    await getProviderFormConfig(
      "openai-compatible",
      "post-processing",
    ).testIntegration(key(), "post-processing");

    expect(createOpenAICompatibleFetch).toHaveBeenCalledWith("key-1");
    expect(spy.mock.calls[0]![0].customFetch).toBeDefined();
  });
});
