import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "openrouterGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/openrouter.utils");
    return mod;
  },
  functionName: "openrouterGenerateTextResponse",
  defaultModel: "openai/gpt-4o-mini",
  expectedJsonResponseType: "json_schema",
  maxTokensKey: "max_tokens",
});

describe("openrouterTranscribeAudio", () => {
  /** The options each constructed client was given, so the fetch can be read. */
  const clientOptionsSeen = (): Array<Record<string, unknown>> =>
    clientOptionsSeenRaw.mock.calls.map(([options]) => options);
  const clientOptionsSeenRaw = vi.hoisted(() => vi.fn());

  const setupTranscriptionMock = (create: ReturnType<typeof vi.fn>) => {
    vi.resetModules();
    clientOptionsSeenRaw.mockClear();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        constructor(options: Record<string, unknown>) {
          clientOptionsSeenRaw(options);
        }
        audio = {
          transcriptions: {
            create,
          },
        };
      },
      toFile: async (blob: ArrayBuffer | Buffer, name: string) => ({
        blob,
        name,
      }),
    }));
  };

  it("sends audio to the OpenRouter transcriptions endpoint via the OpenAI SDK", async () => {
    const create = vi.fn().mockResolvedValue({ text: "hello world" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    const result = await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    expect(result.text).toBe("hello world");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/whisper-1",
    });
  });

  it("forwards a non-auto language to the OpenAI SDK", async () => {
    const create = vi.fn().mockResolvedValue({ text: "你好" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(4),
      ext: "wav",
      language: "zh",
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ language: "zh" });
  });

  it("omits language when the value is auto", async () => {
    const create = vi.fn().mockResolvedValue({ text: "hi" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(4),
      ext: "wav",
      language: "auto",
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      language: undefined,
    });
  });

  it("throws when the response text is empty", async () => {
    const create = vi.fn().mockResolvedValue({ text: "" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await expect(
      openrouterTranscribeAudio({
        apiKey: "test-key",
        model: "openai/whisper-1",
        blob: new ArrayBuffer(4),
        ext: "wav",
      }),
    ).rejects.toThrow("Transcription failed");
  });

  it("builds its client with the caller's fetch", async () => {
    // Every other OpenRouter entry point takes a `customFetch`, and the desktop
    // app wires each of its transcription providers with the app's own native
    // or secure request path. This call dropped it, so OpenRouter transcription
    // was the one provider that could not use the configured transport and
    // always went out over the SDK's default one.
    const customFetch = vi.fn().mockResolvedValue({ text: "unused" });
    const create = vi.fn().mockResolvedValue({ text: "hello world" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
      customFetch,
    });

    const [clientOptions] = clientOptionsSeen();
    expect(clientOptions.fetch).toBe(customFetch);
  });
});

import { createJsonResponseFormatTests } from "../src/test-helpers/shared-json-response-format.helper";

createJsonResponseFormatTests({
  describeName: "openrouterGenerateTextResponse response_format selection",
  loadModule: async () => {
    const mod = await import("../src/openrouter.utils");
    return mod;
  },
  functionName: "openrouterGenerateTextResponse",
  jsonObjectModels: ["openai/gpt-4-turbo", "openai/gpt-4-1106-preview"],
  jsonSchemaModels: ["openai/o3-mini", "openai/gpt-oss-20b"],
});

describe("openrouter o-series parameters", () => {
  // OpenRouter routes `openai/o1` and `openai/o3-mini` to models that reject
  // `temperature` and `top_p` as unsupported, and answer HTTP 400 before
  // generating anything. The id carries a vendor prefix, so the check has to see
  // through it rather than treating every OpenRouter id as a third-party model.
  const paramsFor = async (model: string) => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
      usage: { total_tokens: 5 },
    });
    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = { completions: { create } };
      },
      toFile: vi.fn().mockResolvedValue({}),
    }));
    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");
    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      model,
      prompt: "hi",
    });
    return create.mock.calls[0]?.[0] as Record<string, unknown>;
  };

  it.each([["openai/o1"], ["openai/o3-mini"], ["openai/o4-mini"]])(
    "sends neither temperature nor top_p to %s",
    async (model) => {
      const params = await paramsFor(model);
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
      expect(params).toMatchObject({ model });
    },
  );

  it.each([
    ["anthropic/claude-3"],
    ["meta-llama/llama-3-70b"],
    ["openai/gpt-4o"],
  ])("still sends both to %s", async (model) => {
    const params = await paramsFor(model);
    expect(params).toMatchObject({ temperature: 1, top_p: 1 });
  });
});
