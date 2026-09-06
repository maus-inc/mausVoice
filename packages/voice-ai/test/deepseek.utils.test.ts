import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "deepseekGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/deepseek.utils");
    return mod;
  },
  functionName: "deepseekGenerateTextResponse",
  defaultModel: "deepseek-v4-flash",
  maxTokensKey: "max_tokens",
});

describe("deepseekGenerateTextResponse request shape", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  const mockCreate = (create: ReturnType<typeof vi.fn>) => {
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create,
          },
        };
      },
    }));
  };

  it("defaults to deepseek-v4-flash when no model is configured", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);

    const { deepseekGenerateTextResponse } =
      await import("../src/deepseek.utils");

    await deepseekGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "deepseek-v4-flash",
      top_p: 1,
    });
  });

  it("adds temperature 1 and marks the request json_object when a schema is requested", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);

    const { deepseekGenerateTextResponse } =
      await import("../src/deepseek.utils");

    await deepseekGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
      jsonResponse: {
        name: "schema",
        description: "x",
        schema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
        },
      },
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      temperature: 1,
      response_format: { type: "json_object" },
    });
  });
});
