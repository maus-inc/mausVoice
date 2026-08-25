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
});
