import { afterEach, describe, expect, it, vi } from "vitest";

describe("cerebrasGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  it("uses the hardcoded max_tokens when maxTokens is undefined", async () => {
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

    const { cerebrasGenerateTextResponse } =
      await import("../src/cerebras.utils");

    await cerebrasGenerateTextResponse({
      apiKey: "test-key",
      model: "llama3.1-8b",
      prompt: "hello",
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_tokens: 1024,
    });
  });

  it("forwards caller-owned maxTokens to max_tokens when provided", async () => {
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

    const { cerebrasGenerateTextResponse } =
      await import("../src/cerebras.utils");

    await cerebrasGenerateTextResponse({
      apiKey: "test-key",
      model: "llama3.1-8b",
      prompt: "hello",
      maxTokens: 600,
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_tokens: 600,
    });
  });

  it("uses json_object and injects schema into the prompt when jsonResponse is set", async () => {
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

    const { cerebrasGenerateTextResponse } =
      await import("../src/cerebras.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await cerebrasGenerateTextResponse({
      apiKey: "test-key",
      model: "llama3.1-8b",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      response_format: { type: "json_object" },
    });
    const sentMessages = createCompletion.mock.calls[0][0]?.messages as
      | Array<{
          content: string | Array<{ type: string; text: string }>;
        }>
      | undefined;
    const userContent = sentMessages?.[0]?.content;
    const userText = Array.isArray(userContent)
      ? userContent.map((p) => p.text).join("")
      : String(userContent);
    expect(userText).toContain(JSON.stringify(jsonResponse.schema));
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

    const { cerebrasGenerateTextResponse } =
      await import("../src/cerebras.utils");

    await cerebrasGenerateTextResponse({
      apiKey: "test-key",
      model: "llama3.1-8b",
      prompt: "hi",
    });

    expect(createCompletion.mock.calls[0][0]?.response_format).toBeUndefined();
  });
});
