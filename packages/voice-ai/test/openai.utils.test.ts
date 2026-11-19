import { describe, expect, it, vi } from "vitest";
import { OPENAI_GENERATE_TEXT_MODELS } from "../src/openai.utils";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "openaiGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/openai.utils");
    return mod;
  },
  functionName: "openaiGenerateTextResponse",
  defaultModel: "gpt-4o-mini",
  expectedJsonResponseType: "json_schema",
});

describe("supportsOpenAIJsonSchema", () => {
  it("supports json_schema for all OPENAI_GENERATE_TEXT_MODELS", async () => {
    const { supportsOpenAIJsonSchema } = await import("../src/openai.utils");

    for (const model of OPENAI_GENERATE_TEXT_MODELS) {
      expect(supportsOpenAIJsonSchema(model)).toBe(true);
    }
  });
});

import { createJsonResponseFormatTests } from "../src/test-helpers/shared-json-response-format.helper";

createJsonResponseFormatTests({
  describeName: "openaiGenerateTextResponse response_format selection",
  loadModule: async () => {
    const mod = await import("../src/openai.utils");
    return mod;
  },
  functionName: "openaiGenerateTextResponse",
  jsonObjectModels: [
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-4-1106-preview",
    "gpt-4-turbo-preview",
    "gpt-4-0314",
    "gpt-3.5-turbo-16k",
    "gpt-4-vision-preview",
  ],
  jsonSchemaModels: [
    "o3-mini",
    "gpt-4o-mini",
    "gpt-4o-2024-08-06",
    "gpt-5-mini",
  ],
});

describe("openaiGenerateTextResponse token limit field", () => {
  const runGenerate = async (model: string, maxTokens?: number) => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 5 },
    });
    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = { completions: { create } };
      },
    }));
    const { openaiGenerateTextResponse } = await import("../src/openai.utils");
    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model,
      prompt: "hi",
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
    return create.mock.calls[0]?.[0] as Record<string, unknown>;
  };

  // `max_completion_tokens` arrived with the o-series and is the only spelling
  // those models accept, but the pre-turbo GPT-4 and GPT-3.5 line this package
  // already enumerates in OPENAI_LEGACY_CHAT_MODELS rejects the field outright
  // with a 400 for an unrecognised request argument. They are reachable as
  // discovered model ids, so the same request shape that works on gpt-4o-mini
  // used to fail on the legacy ids the response-format rules go to the trouble
  // of supporting.
  it.each([
    "gpt-4",
    "gpt-4-turbo",
    "gpt-4-32k-0613",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-16k",
  ])("sends max_tokens to the legacy model %s", async (model) => {
    const params = await runGenerate(model, 600);
    expect(params.max_tokens).toBe(600);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it.each(["gpt-4o-mini", "gpt-5-mini", "gpt-4.1", "o3-mini", "gpt-oss-20b"])(
    "sends max_completion_tokens to %s",
    async (model) => {
      const params = await runGenerate(model, 600);
      expect(params.max_completion_tokens).toBe(600);
      expect(params).not.toHaveProperty("max_tokens");
    },
  );

  it("keeps the hardcoded default on both branches", async () => {
    for (const [model, field] of [
      ["gpt-4-turbo", "max_tokens"],
      ["gpt-4o-mini", "max_completion_tokens"],
    ] as const) {
      const params = await runGenerate(model);
      expect(params[field]).toBe(1024);
    }
  });
});
