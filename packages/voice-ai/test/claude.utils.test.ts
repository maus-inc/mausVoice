import { afterEach, describe, expect, it, vi } from "vitest";

describe("claudeGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("uses the hardcoded max_tokens when maxTokens is undefined", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: createMessage,
        };
      },
    }));

    const { claudeGenerateTextResponse } = await import("../src/claude.utils");

    await claudeGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0][0]).toMatchObject({
      max_tokens: 1024,
    });
  });

  it("forwards caller-owned maxTokens to max_tokens when provided", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: createMessage,
        };
      },
    }));

    const { claudeGenerateTextResponse } = await import("../src/claude.utils");

    await claudeGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
      maxTokens: 600,
    });

    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0][0]).toMatchObject({
      max_tokens: 600,
    });
  });
});
