import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_GENERATE_TEXT_MODELS } from "../src/openai.utils";

describe("openaiGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  it("uses the hardcoded max_completion_tokens when maxTokens is undefined", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ result: "ok" }),
          },
        },
      ],
      usage: {
        total_tokens: 5,
      },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 1024,
    });
  });

  it("forwards caller-owned maxTokens to max_completion_tokens when provided", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ result: "ok" }),
          },
        },
      ],
      usage: {
        total_tokens: 5,
      },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
      maxTokens: 600,
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 600,
    });
  });

  it("uses json_schema for first-party OpenAI models when jsonResponse is set", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      model: "gpt-4o-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: jsonResponse.name,
          description: jsonResponse.description,
          schema: jsonResponse.schema,
          strict: true,
        },
      },
    });
  });

  it("falls back to json_object for proxied non-OpenAI models", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "meta-llama/llama-3.1-70b-instruct",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      model: "meta-llama/llama-3.1-70b-instruct",
      response_format: { type: "json_object" },
    });
  });

  it("omits response_format when jsonResponse is not set", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "gpt-4o",
      prompt: "hi",
    });

    expect(createCompletion.mock.calls[0][0]?.response_format).toBeUndefined();
  });
});

describe("supportsOpenAIJsonSchema", () => {
  it("supports json_schema for all OPENAI_GENERATE_TEXT_MODELS", async () => {
    const { supportsOpenAIJsonSchema } = await import("../src/openai.utils");

    for (const model of OPENAI_GENERATE_TEXT_MODELS) {
      expect(supportsOpenAIJsonSchema(model)).toBe(true);
    }
  });
});
