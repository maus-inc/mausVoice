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
  redactCerebrasMessage,
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

describe("redactCerebrasMessage", () => {
  it("redacts sk- keys without matching inside identifiers like task-123", () => {
    expect(redactCerebrasMessage("key sk-liveAbCd1234 used")).toBe(
      "key [redacted] used",
    );
    expect(redactCerebrasMessage("ticket task-123 is open")).toBe(
      "ticket task-123 is open",
    );
  });

  it("redacts bearer tokens case-insensitively without leaking the value", () => {
    expect(redactCerebrasMessage("Authorization: Bearer Abc_123")).toContain(
      "[redacted]",
    );
    expect(redactCerebrasMessage("Authorization: Bearer Abc_123")).not.toMatch(
      /Abc_123/,
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

  it("redacts key material echoed by a transient 5xx proxy error", () => {
    const proxyError = Object.assign(
      new Error("upstream 500: Authorization: Bearer csk_proxy12345"),
      { status: 500 },
    );
    const normalized = normalizeCerebrasError(proxyError);
    // Retriable, but the key must not survive to logs/metadata.
    expect(normalized).not.toBeInstanceOf(CerebrasProviderError);
    expect(normalized.message).not.toMatch(/csk_[A-Za-z0-9]/);
    expect(normalized.message).toContain("[redacted]");
  });

  it("wraps other terminal 4xx statuses", () => {
    const sdkError = Object.assign(new Error("unauthorized"), { status: 401 });
    const normalized = normalizeCerebrasError(sdkError);
    expect(normalized).toBeInstanceOf(CerebrasProviderError);
    expect((normalized as CerebrasProviderError).status).toBe(401);
  });

  it("redacts an API key embedded in a terminal SDK error message", () => {
    // The OpenAI SDK echoes the supplied key in its 401 APIError message.
    const sdkError = Object.assign(
      new Error(
        "Incorrect API key provided: csk_liveAbCd1234. You can find your API key at https://console.cerebras.ai",
      ),
      { status: 401 },
    );

    const normalized = normalizeCerebrasError(sdkError);

    expect(normalized).toBeInstanceOf(CerebrasProviderError);
    expect(normalized.message).toContain("Incorrect API key provided");
    expect(normalized.message).not.toMatch(/csk_[A-Za-z0-9]/);
    expect(normalized.message).toContain("[redacted]");
    // A key truncated by the provider must not be reconstructed; the whole
    // token is replaced, never partially preserved.
    expect(normalized.message).not.toContain("csk_liveAbCd1234");
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
