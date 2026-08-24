import { describe, expect, it, vi } from "vitest";

const { clientOptions, listModels, createChatCompletion } = vi.hoisted(() => ({
  clientOptions: vi.fn(),
  listModels: vi.fn().mockResolvedValue({ data: [{ id: "gpt-oss-120b" }] }),
  createChatCompletion: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    models = { list: listModels };
    chat = {
      completions: { create: createChatCompletion },
    };

    constructor(options: unknown) {
      clientOptions(options);
    }
  },
}));

import {
  CEREBRAS_MODELS,
  CerebrasProviderError,
  cerebrasGenerateTextResponse,
  cerebrasTestIntegration,
  isCerebrasTerminalStatus,
  normalizeCerebrasError,
} from "./cerebras.utils";

describe("Cerebras provider", () => {
  it("uses the current public models as offline fallbacks", () => {
    expect(CEREBRAS_MODELS).toEqual(["gpt-oss-120b", "gemma-4-31b"]);
  });

  it("tests credentials by listing live models instead of calling a stale fixed model", async () => {
    const customFetch = vi.fn();

    await expect(
      cerebrasTestIntegration({ apiKey: " csk_test ", customFetch }),
    ).resolves.toBe(true);
    expect(listModels).toHaveBeenCalledOnce();
    expect(clientOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "csk_test",
        baseURL: "https://api.cerebras.ai/v1",
        fetch: customFetch,
      }),
    );
  });
});

describe("normalizeCerebrasError", () => {
  it("maps a 402 with no body to an actionable Cerebras billing error", () => {
    // The OpenAI SDK raises APIError with `status` set; an empty response body
    // is exactly what the user reported ("402 status code (no body)").
    const sdkError = Object.assign(new Error("402 status code (no body)"), {
      status: 402,
    });

    const normalized = normalizeCerebrasError(sdkError);

    expect(normalized).toBeInstanceOf(CerebrasProviderError);
    expect((normalized as CerebrasProviderError).status).toBe(402);
    expect(normalized.message).toMatch(/cerebras/i);
    expect(normalized.message).toMatch(/credit|quota|billing|access/i);
    // The error must never carry the API key or authorization material.
    expect(normalized.message).not.toMatch(/csk_|bearer|authorization/i);
  });

  it("passes a 5xx through as retriable", () => {
    const sdkError = Object.assign(new Error("bad gateway"), { status: 502 });
    const normalized = normalizeCerebrasError(sdkError);
    expect(normalized).not.toBeInstanceOf(CerebrasProviderError);
    expect(normalized.message).toBe("bad gateway");
  });

  it("wraps other terminal 4xx statuses", () => {
    const sdkError = Object.assign(new Error("unauthorized"), { status: 401 });
    const normalized = normalizeCerebrasError(sdkError);
    expect(normalized).toBeInstanceOf(CerebrasProviderError);
    expect((normalized as CerebrasProviderError).status).toBe(401);
  });

  it("coerces a non-error throwable", () => {
    expect(normalizeCerebrasError("boom").message).toBe("boom");
  });

  it("marks the billing statuses as non-retryable", () => {
    expect(isCerebrasTerminalStatus(402)).toBe(true);
    expect(isCerebrasTerminalStatus(401)).toBe(true);
    expect(isCerebrasTerminalStatus(429)).toBe(false);
    expect(isCerebrasTerminalStatus(500)).toBe(false);
  });
});

describe("cerebrasGenerateTextResponse 402 handling", () => {
  it("surfaces a provider-specific error and does not retry a 402", async () => {
    const sdkError = Object.assign(new Error("402 status code (no body)"), {
      status: 402,
    });
    createChatCompletion.mockRejectedValueOnce(sdkError);

    await expect(
      cerebrasGenerateTextResponse({
        apiKey: "csk_test",
        prompt: "hello",
      }),
    ).rejects.toMatchObject({
      name: "CerebrasProviderError",
      status: 402,
    });

    // A terminal 402 must not be retried.
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });
});
