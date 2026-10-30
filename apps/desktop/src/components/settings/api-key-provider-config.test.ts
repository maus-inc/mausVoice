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

/*
 * A namespace import, not named ones: the table below selects six different
 * `*TestIntegration` exports by a runtime key, so the members cannot be known
 * at the import site. Replacing this with a hand-maintained lookup was tried
 * and is strictly worse -- `it.each` widens the key to `string`, so a name
 * missing from that list is not a type error but a runtime failure far from
 * the table that declared it.
 */
import * as voiceAi from "@maus-inc/voice-ai";

const voiceAiMockFor = (fnName: string) => {
  const fn = (voiceAi as unknown as Record<string, ReturnType<typeof vi.fn>>)[
    fnName
  ];
  if (!fn)
    throw new Error(`Expected ${fnName} to be exported by @maus-inc/voice-ai`);
  return fn;
};

/**
 * The first call's single argument. Going through here rather than indexing
 * `spy.mock.calls[0]![0]` means a mock that was never called fails with the
 * name of the export under test rather than a TypeError about `undefined`.
 */
const firstCallArgOf = (
  spy: ReturnType<typeof vi.fn>,
  fnName: string,
): Record<string, unknown> => {
  const call = spy.mock.calls.at(0);
  if (!call) throw new Error(`Expected ${fnName} to have been called`);
  return call[0] as Record<string, unknown>;
};
import { API_KEY_PROVIDERS } from "@maus-inc/types";
import { getProviderFormConfig } from "./api-key-provider-config";

describe("provider form config coverage", () => {
  // Regression: `gladia` was a valid ApiKeyProvider with no STANDARD_PROVIDERS
  // entry, so rendering the AI Transcription provider list threw
  // "Cannot read properties of undefined (reading 'displayName')" and the
  // route error boundary took over the page.
  it.each(
    API_KEY_PROVIDERS.flatMap((provider) =>
      (["transcription", "post-processing"] as const).map(
        (context) => [provider, context] as const,
      ),
    ),
  )("%s has a usable form config in the %s list", (provider, context) => {
    const config = getProviderFormConfig(provider, context);

    expect(config.displayName.length).toBeGreaterThan(0);
    expect(config.fields.length).toBeGreaterThan(0);
    expect(typeof config.testIntegration).toBe("function");
  });

  it("names the provider when a foreign provider value has no config", () => {
    expect(() =>
      getProviderFormConfig(
        "not-a-provider" as (typeof API_KEY_PROVIDERS)[number],
        "transcription",
      ),
    ).toThrow(/not-a-provider/);
  });

  it("routes the Gladia test button through the Gladia integration check", async () => {
    const spy = vi.mocked(voiceAi.gladiaTestIntegration);
    spy.mockClear();

    await getProviderFormConfig("gladia", "transcription").testIntegration(
      {
        id: "key-1",
        keyFull: "secret",
      } as Parameters<
        ReturnType<typeof getProviderFormConfig>["testIntegration"]
      >[0],
      "transcription",
    );

    const [firstCall] = spy.mock.calls;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]).toMatchObject({ apiKey: "secret" });
  });
});

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
    const spy = vi.mocked(voiceAiMockFor(fnName));
    spy.mockClear();

    await getProviderFormConfig(
      provider as Parameters<typeof getProviderFormConfig>[0],
      "transcription",
    ).testIntegration(key(), "transcription");

    expect(firstCallArgOf(spy, fnName)).toMatchObject({
      customFetch: secureFetch,
    });
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
    expect(
      firstCallArgOf(spy, "openaiCompatibleTestIntegration").customFetch,
    ).toBeDefined();
  });
});
