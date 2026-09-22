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
