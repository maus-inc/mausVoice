import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleGenerateTests,
  mockOpenAIChatCreate,
  resetOpenAIChatCreateMock,
} from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "cerebrasGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/cerebras.utils");
    return mod;
  },
  functionName: "cerebrasGenerateTextResponse",
  defaultModel: "gpt-oss-120b",
  maxTokensKey: "max_tokens",
});

describe("cerebrasGenerateTextResponse error contract", () => {
  afterEach(resetOpenAIChatCreateMock);

  it("surfaces a 402 as a provider error and does not retry", async () => {
    let attempts = 0;
    const create = vi.fn().mockImplementation(async () => {
      attempts += 1;
      const error = Object.assign(new Error("402 status code (no body)"), {
        status: 402,
      });
      throw error;
    });
    mockOpenAIChatCreate(create);

    const { cerebrasGenerateTextResponse, CerebrasProviderError } =
      await import("../src/cerebras.utils");

    await expect(
      cerebrasGenerateTextResponse({
        apiKey: "test-key",
        prompt: "hi",
      }),
    ).rejects.toBeInstanceOf(CerebrasProviderError);

    // A billing/quota failure cannot be fixed by resending the same request.
    expect(attempts).toBe(1);
  });

  it("keeps the 402 status on the error so callers can map it", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("402 status code (no body)"), { status: 402 }),
      );
    mockOpenAIChatCreate(create);

    const { cerebrasGenerateTextResponse, CerebrasProviderError } =
      await import("../src/cerebras.utils");

    const error = await cerebrasGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CerebrasProviderError);
    expect((error as CerebrasProviderError).status).toBe(402);
  });
});

describe("cerebrasGenerateTextResponse reasoning controls", () => {
  afterEach(resetOpenAIChatCreateMock);

  const runRequest = async (model: string) => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockOpenAIChatCreate(create);

    const { cerebrasGenerateTextResponse } =
      await import("../src/cerebras.utils");
    await cerebrasGenerateTextResponse({
      apiKey: "test-key",
      model,
      prompt: "hi",
    });

    return create.mock.calls[0][0] as Record<string, unknown>;
  };

  it("asks gpt-oss-120b for low-effort reasoning with the channel hidden", async () => {
    // gpt-oss-120b defaults to medium effort and reasoning tokens are charged
    // against the same completion budget as the JSON reply.
    const params = await runRequest("gpt-oss-120b");

    expect(params).toMatchObject({
      reasoning_effort: "low",
      reasoning_format: "hidden",
    });
  });

  it("sends no reasoning params for gemma-4-31b", async () => {
    // Cerebras rejects reasoning_format on models without a reasoning
    // channel; the params must stay off the request entirely.
    const params = await runRequest("gemma-4-31b");

    expect(params).not.toHaveProperty("reasoning_effort");
    expect(params).not.toHaveProperty("reasoning_format");
  });
});
