import { afterEach, describe, expect, it, vi } from "vitest";

describe("groqGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("groq-sdk/index");
    vi.resetModules();
  });

  it("uses a small completion budget for structured transcript cleanup", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ result: "Hello there" }),
          },
        },
      ],
      usage: {
        total_tokens: 42,
      },
    });

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    await groqGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello there",
      jsonResponse: {
        name: "transcription_cleaning",
        description: "JSON response with the processed transcription",
        schema: {
          type: "object",
          properties: {
            result: {
              type: "string",
            },
          },
          required: ["result"],
        },
      },
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 5000,
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
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    await groqGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello there",
      maxTokens: 600,
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 600,
    });
  });

  it("uses json_schema for Groq models that support structured outputs", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await groqGenerateTextResponse({
      apiKey: "test-key",
      model: "openai/gpt-oss-20b",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      model: "openai/gpt-oss-20b",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: jsonResponse.name,
          description: jsonResponse.description,
          schema: jsonResponse.schema,
        },
      },
    });
  });

  it("falls back to json_object for Groq models without structured-output support", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await groqGenerateTextResponse({
      apiKey: "test-key",
      model: "qwen/qwen3.6-27b",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      model: "qwen/qwen3.6-27b",
      response_format: { type: "json_object" },
    });
  });
});
