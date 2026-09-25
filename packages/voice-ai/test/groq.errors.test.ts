import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isProviderTerminalError,
  isProviderTerminalStatus,
  PROVIDER_MODEL_NOT_FOUND_CODE,
  readProviderCode,
  readProviderStatus,
  redactProviderMessage,
} from "../src/provider-error.utils";
import { GroqProviderError, normalizeGroqError } from "../src/groq.utils";

const RETIRED_MODEL = "qwen/qwen3.6-27b";

/** The exact 404 shape Groq returns for a model it no longer serves. */
const retiredModelError = (model: string = RETIRED_MODEL) =>
  Object.assign(
    new Error(
      `The model \`${model}\` does not exist or you do not have access to it.`,
    ),
    {
      status: 404,
      error: {
        code: PROVIDER_MODEL_NOT_FOUND_CODE,
        type: "invalid_request_error",
      },
    },
  );

describe("provider terminal status", () => {
  it.each([400, 401, 402, 403, 404, 422])(
    "treats %i as non-retryable",
    (status) => {
      expect(isProviderTerminalStatus(status)).toBe(true);
    },
  );

  it.each([408, 429, 500, 502, 503])("treats %i as retryable", (status) => {
    expect(isProviderTerminalStatus(status)).toBe(false);
  });

  it("reports no status for a network failure or an abort", () => {
    expect(readProviderStatus(new Error("socket hang up"))).toBeUndefined();
    expect(isProviderTerminalError(new Error("socket hang up"))).toBe(false);
  });
});

describe("readProviderCode", () => {
  it("reads the code from the parsed error body the SDK exposes", () => {
    expect(readProviderCode(retiredModelError())).toBe("model_not_found");
  });

  it("reads a code set directly on the error", () => {
    expect(readProviderCode({ code: "model_not_found" })).toBe(
      "model_not_found",
    );
  });

  it("returns undefined when the provider sends no code", () => {
    expect(readProviderCode(new Error("boom"))).toBeUndefined();
    expect(readProviderCode("boom")).toBeUndefined();
  });
});

describe("redactProviderMessage", () => {
  it("removes a Groq key echoed by a terminal error", () => {
    const message = redactProviderMessage(
      "Incorrect API key provided: gsk_liveAbCd1234",
    );
    expect(message).toContain("[redacted]");
    expect(message).not.toMatch(/gsk_[A-Za-z0-9]/);
  });

  it("does not treat an ordinary hyphenated word as a key", () => {
    expect(redactProviderMessage("ticket task-123 is open")).toBe(
      "ticket task-123 is open",
    );
  });
});

describe("normalizeGroqError", () => {
  it("names the retired model instead of leaking the raw provider 404", () => {
    const normalized = normalizeGroqError({
      error: retiredModelError(),
      model: RETIRED_MODEL,
    });

    expect(normalized).toBeInstanceOf(GroqProviderError);
    expect(normalized.message).toContain(RETIRED_MODEL);
    // The user has to be told where to change it, not just that it broke.
    expect(normalized.message).toContain("Settings");
    // No raw JSON body and no "does not exist" provider phrasing leaking out.
    expect(normalized.message).not.toContain("invalid_request_error");
    expect((normalized as GroqProviderError).status).toBe(404);
    expect((normalized as GroqProviderError).code).toBe("model_not_found");
  });

  it("marks a retired model as non-retryable so the caller stops retrying", () => {
    expect(
      isProviderTerminalError(
        normalizeGroqError({
          error: retiredModelError(),
          model: RETIRED_MODEL,
        }),
      ),
    ).toBe(true);
  });

  it("reports other terminal statuses with their status and a redacted detail", () => {
    const normalized = normalizeGroqError({
      error: Object.assign(new Error("Invalid API key: gsk_secret123"), {
        status: 401,
      }),
      model: "openai/gpt-oss-20b",
    });

    expect(normalized).toBeInstanceOf(GroqProviderError);
    expect((normalized as GroqProviderError).status).toBe(401);
    expect(normalized.message).toContain("401");
    expect(normalized.message).not.toMatch(/gsk_[A-Za-z0-9]/);
  });

  it("keeps a 5xx transient so retry still gets another attempt", () => {
    const normalized = normalizeGroqError({
      error: Object.assign(new Error("bad gateway"), { status: 502 }),
      model: "openai/gpt-oss-20b",
    });

    expect(normalized).not.toBeInstanceOf(GroqProviderError);
    expect(isProviderTerminalError(normalized)).toBe(false);
  });

  it("does not re-wrap an error that is already normalized", () => {
    const once = normalizeGroqError({
      error: retiredModelError(),
      model: RETIRED_MODEL,
    });
    expect(normalizeGroqError({ error: once, model: RETIRED_MODEL })).toBe(
      once,
    );
  });
});

/** Load a fresh groq.utils whose SDK client rejects every create with `error`. */
const runFailingGroqCall = async (error: unknown, model: string) => {
  const createCompletion = vi.fn().mockRejectedValue(error);

  vi.resetModules();
  vi.doMock("groq-sdk/index", () => ({
    default: class MockGroq {
      chat = {
        completions: {
          create: createCompletion,
        },
      };
    },
    toFile: vi.fn(),
  }));

  const { groqGenerateTextResponse } = await import("../src/groq.utils");

  const thrown = await groqGenerateTextResponse({
    apiKey: "test-key",
    model,
    prompt: "hi",
  }).catch((caught: unknown) => caught);

  return { createCompletion, thrown };
};

describe("groqGenerateTextResponse on a retired model", () => {
  afterEach(() => {
    vi.doUnmock("groq-sdk/index");
    vi.resetModules();
  });

  it("spends one request instead of retrying a failure that cannot change", async () => {
    const { createCompletion, thrown } = await runFailingGroqCall(
      retiredModelError(),
      RETIRED_MODEL,
    );

    // The module was re-imported after a reset, so the class identity differs
    // from the static import above. Assert on what the caller observes instead.
    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect((thrown as Error).name).toBe("GroqProviderError");
    expect((thrown as GroqProviderError).status).toBe(404);
    expect((thrown as Error).message).toContain(RETIRED_MODEL);
    expect((thrown as Error).message).toContain("Settings");
  });

  it("still retries a transient failure", async () => {
    const { createCompletion } = await runFailingGroqCall(
      Object.assign(new Error("service unavailable"), { status: 503 }),
      "openai/gpt-oss-20b",
    );

    expect(createCompletion).toHaveBeenCalledTimes(3);
  });
});
