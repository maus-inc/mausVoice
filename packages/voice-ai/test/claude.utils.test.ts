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

describe("claudeStreamChat tool wiring", () => {
  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  /**
   * A stream the generator can consume and then ask for its final message,
   * which is the only two things `claudeStreamChat` does with the SDK's
   * `MessageStream`.
   */
  const mockStream = () => {
    const stream = vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // No events: the request shape is what these cases are about.
      },
      finalMessage: vi.fn().mockResolvedValue({
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        model: "claude-sonnet-5",
      }),
    });
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = { stream };
      },
    }));
    return stream;
  };

  const streamParams = async (
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const stream = mockStream();
    const { claudeStreamChat } = await import("../src/claude.utils");

    for await (const _event of claudeStreamChat({
      apiKey: "test-key",
      model: "claude-sonnet-5",
      input: {
        messages: [{ role: "user", content: "hi" }],
        ...input,
      },
    })) {
      // drain
    }

    expect(stream).toHaveBeenCalledTimes(1);
    return stream.mock.calls[0]?.[0] as Record<string, unknown>;
  };

  // An empty list is a request with no tool definitions, and `[]` is truthy,
  // so a truthiness test called it "has tools" and sent `tools: []` next to the
  // tool choice that names nothing. Nothing here chooses between tools, so both
  // fields are dropped instead.
  it("sends neither tools nor tool choice when the tool list is empty", async () => {
    const params = await streamParams({ tools: [], toolChoice: "auto" });

    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
  });

  it("still sends the tools and the choice the caller asked for", async () => {
    const params = await streamParams({
      tools: [{ name: "lookup", parameters: { type: "object" } }],
      toolChoice: "auto",
    });

    expect(params.tools).toEqual([
      {
        name: "lookup",
        description: "",
        input_schema: { type: "object" },
      },
    ]);
    expect(params.tool_choice).toEqual({ type: "auto" });
  });

  // The other half of the same pairing: a choice with no tool definitions goes
  // out alone on a request that declares none.
  it("drops the tool choice when the caller sends no tool list at all", async () => {
    const params = await streamParams({ toolChoice: "required" });

    expect(params.tools).toBeUndefined();
    expect(params.tool_choice).toBeUndefined();
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
