import { afterEach, describe, expect, it, vi } from "vitest";

describe("azureOpenAIGenerateText", () => {
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
      AzureOpenAI: class MockAzureOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { azureOpenAIGenerateText } =
      await import("../src/azure-openai.utils");

    await azureOpenAIGenerateText({
      apiKey: "test-key",
      endpoint: "https://example.azure.com",
      deploymentName: "gpt-4o-mini",
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
      AzureOpenAI: class MockAzureOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { azureOpenAIGenerateText } =
      await import("../src/azure-openai.utils");

    await azureOpenAIGenerateText({
      apiKey: "test-key",
      endpoint: "https://example.azure.com",
      deploymentName: "gpt-4o-mini",
      prompt: "hello",
      maxTokens: 600,
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 600,
    });
  });
});
