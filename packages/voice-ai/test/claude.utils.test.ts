import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicGenerateTests } from "../src/test-helpers/shared-anthropic-generate.helper";

createAnthropicGenerateTests({
  describeName: "claudeGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/claude.utils");
    return mod;
  },
  functionName: "claudeGenerateTextResponse",
  defaultMaxTokens: 1024,
  forwardedMaxTokens: 600,
});

describe("claudeGenerateTextResponse request shape", () => {
  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  const mockCreate = (createMessage: ReturnType<typeof vi.fn>) => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: createMessage,
        };
      },
    }));
  };

  it("forwards the system prompt as the top-level system field", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    mockCreate(createMessage);

    const { claudeGenerateTextResponse } = await import("../src/claude.utils");

    await claudeGenerateTextResponse({
      apiKey: "test-key",
      prompt: "summarize",
      system: "Be extremely concise.",
    });

    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      system: "Be extremely concise.",
    });
  });

  it("omits system when no system prompt is provided", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    mockCreate(createMessage);

    const { claudeGenerateTextResponse } = await import("../src/claude.utils");

    await claudeGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
    });

    expect(createMessage.mock.calls[0]?.[0]?.system).toBeUndefined();
  });
});

describe("claudeTestIntegration", () => {
  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("reports the endpoint usable when models.list succeeds", async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        models = { list };
      },
    }));

    const { claudeTestIntegration } = await import("../src/claude.utils");

    await expect(claudeTestIntegration({ apiKey: "test-key" })).resolves.toBe(
      true,
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("propagates a connectivity failure from models.list", async () => {
    const list = vi.fn().mockRejectedValue(new Error("network down"));
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        models = { list };
      },
    }));

    const { claudeTestIntegration } = await import("../src/claude.utils");

    await expect(claudeTestIntegration({ apiKey: "test-key" })).rejects.toThrow(
      "network down",
    );
  });
});
