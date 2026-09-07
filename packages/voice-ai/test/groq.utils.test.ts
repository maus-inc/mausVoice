import { afterEach, describe, expect, it, vi } from "vitest";

const runGroqJsonResponseCase = async (model: string) => {
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
    model,
    prompt: "hi",
    jsonResponse,
  });

  return { call: createCompletion.mock.calls[0][0], jsonResponse };
};

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
    const { call, jsonResponse } =
      await runGroqJsonResponseCase("openai/gpt-oss-20b");

    expect(call).toMatchObject({
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
    const { call } = await runGroqJsonResponseCase("qwen/qwen3.6-27b");

    expect(call).toMatchObject({
      model: "qwen/qwen3.6-27b",
      response_format: { type: "json_object" },
    });
  });

  it("retries a transient failure when a caller signal is present but not aborted", async () => {
    // Regression: `retries: signal ? 1 : 3` treated signal presence as an
    // abort and dropped every retry. Only an actually aborted signal is
    // terminal.
    const createCompletion = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
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

    const controller = new AbortController();
    await groqGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
      signal: controller.signal,
    });

    expect(createCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not retry after the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const createCompletion = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

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

    await expect(
      groqGenerateTextResponse({
        apiKey: "test-key",
        prompt: "hi",
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(createCompletion).toHaveBeenCalledTimes(1);
  });
});
