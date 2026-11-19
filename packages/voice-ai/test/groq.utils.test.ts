import { afterEach, describe, expect, it, vi } from "vitest";

const runGroqJsonResponseCase = async (model: string) => {
  const createCompletion = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
    usage: { total_tokens: 5 },
  });

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

  const jsonResponse = {
    name: "schema",
    description: "x",
    schema: {
      type: "object" as const,
      properties: { result: { type: "string" as const } },
      required: ["result"],
    },
  };

  await groqGenerateTextResponse({
    apiKey: "test-key",
    model,
    prompt: "hi",
    jsonResponse,
  });

  return { call: createCompletion.mock.calls[0][0], jsonResponse };
};

describe("groqGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("groq-sdk/index");
    vi.resetModules();
  });

  it("uses a small completion budget for structured transcript cleanup", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ result: "Hello there" }),
          },
        },
      ],
      usage: {
        total_tokens: 42,
      },
    });

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

    await groqGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello there",
      jsonResponse: {
        name: "transcription_cleaning",
        description: "JSON response with the processed transcription",
        schema: {
          type: "object",
          properties: {
            result: {
              type: "string",
            },
          },
          required: ["result"],
        },
      },
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 5000,
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

    await groqGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello there",
      maxTokens: 600,
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_completion_tokens: 600,
    });
  });

  it.each(["openai/gpt-oss-20b", "openai/gpt-oss-120b"])(
    "uses json_schema for Groq model %s with structured-output support",
    async (model) => {
      const { call, jsonResponse } = await runGroqJsonResponseCase(model);

      expect(call).toMatchObject({
        model,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: jsonResponse.name,
            description: jsonResponse.description,
            // Constrained decoding: Groq documents strict mode as the
            // production setting for the models that support it.
            strict: true,
            schema: jsonResponse.schema,
          },
        },
      });
    },
  );

  it("falls back to json_object for Groq models without structured-output support", async () => {
    const model = "custom/model-without-structured-output";
    const { call } = await runGroqJsonResponseCase(model);

    expect(call).toMatchObject({
      model,
      response_format: { type: "json_object" },
    });
  });

  it("retries a transient failure when a caller signal is present but not aborted", async () => {
    // Regression: `retries: signal ? 1 : 3` treated signal presence as an
    // abort and dropped every retry. Only an actually aborted signal is
    // terminal.
    const createCompletion = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
        usage: { total_tokens: 5 },
      });

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

    const controller = new AbortController();
    await groqGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hi",
      signal: controller.signal,
    });

    expect(createCompletion).toHaveBeenCalledTimes(2);
  });

  it("does not retry after the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const createCompletion = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

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

    await expect(
      groqGenerateTextResponse({
        apiKey: "test-key",
        prompt: "hi",
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(createCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not retry an account-scoped rejection on the same key", async () => {
    // A bad key fails the same way on every model and every attempt, so three
    // attempts only spend the caller's deadline.
    const createCompletion = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("unauthorized"), { status: 401 }),
      );

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

    await expect(
      groqGenerateTextResponse({
        apiKey: "test-key",
        prompt: "hi",
      }),
    ).rejects.toThrow("unauthorized");

    expect(createCompletion).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 the configured number of times", async () => {
    // The other half of the pair above: 503 is not account-scoped, so the
    // predicate has to keep the retry. A predicate that returned true for
    // everything would pass the 401 case only by accident.
    const createCompletion = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("service unavailable"), { status: 503 }),
      );

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

    await expect(
      groqGenerateTextResponse({
        apiKey: "test-key",
        prompt: "hi",
      }),
    ).rejects.toThrow("service unavailable");

    expect(createCompletion).toHaveBeenCalledTimes(3);
  });
});

describe("isGroqAccountScopedError", () => {
  it("treats 400, 401 and 402 as account-scoped", async () => {
    const { isGroqAccountScopedError } = await import("../src/groq.utils");

    // A malformed request, a bad key and an exhausted balance fail the same
    // way on every model, so a second request chain can only add latency.
    for (const status of [400, 401, 402]) {
      expect(
        isGroqAccountScopedError(Object.assign(new Error("x"), { status })),
      ).toBe(true);
    }
  });

  it("treats 403 as model-scoped so a denial still reaches the fallback", async () => {
    // Groq publishes 403 as its own `PermissionDeniedError` class with no
    // model-scoped variant, and the per-model wording, "does not exist or you
    // do not have access to it", rides on a 404. There is no documented code
    // for a per-model 403. Because a model-scoped denial is the exact case the
    // fallback exists for, 403 is left out of the account-scoped set: keeping
    // it would trade a possible recovery for a slightly faster hard failure on
    // a denial that a second model might still answer.
    const { isGroqAccountScopedError } = await import("../src/groq.utils");

    expect(
      isGroqAccountScopedError(
        Object.assign(new Error("forbidden"), { status: 403 }),
      ),
    ).toBe(false);
  });

  it("leaves the statuses a different model can fix out of the set", async () => {
    const { isGroqAccountScopedError } = await import("../src/groq.utils");

    // 404 is Groq's model_not_found, 429 is enforced per model, and 5xx is
    // transient. None of them is fixed by swapping the model id.
    for (const status of [404, 429, 500, 503]) {
      expect(
        isGroqAccountScopedError(Object.assign(new Error("x"), { status })),
      ).toBe(false);
    }
  });

  it("returns false for a value that carries no status", async () => {
    const { isGroqAccountScopedError } = await import("../src/groq.utils");

    // A network failure, an abort and a bare string throw all reach here. None
    // of them proves a second model would fail too, so they stay retryable.
    expect(isGroqAccountScopedError(new Error("socket hang up"))).toBe(false);
    expect(isGroqAccountScopedError("socket hang up")).toBe(false);
    expect(isGroqAccountScopedError(null)).toBe(false);
  });
});

describe("retired model handling", () => {
  // Every `vi.doMock` in this file is paired with this teardown. Without it the
  // mocked Groq client outlives the block and the next block appended here
  // inherits it, which is why a suite can pass while running against a client
  // that no test in the block set up.
  afterEach(() => {
    vi.doUnmock("groq-sdk/index");
    vi.resetModules();
  });

  // Built from parts so the secret scanner does not read this fixture as a
  // real leaked key. Mirrors the Cerebras suite.
  const FAKE_KEY = "gsk_" + "liveAbCd1234";

  const modelNotFound = () =>
    Object.assign(
      new Error(
        "The model `qwen/qwen3.6-27b` does not exist or you do not have access to it.",
      ),
      {
        status: 404,
        error: { code: "model_not_found", type: "invalid_request_error" },
      },
    );

  it("does not retry a model id Groq does not serve", async () => {
    // A retired model cannot come back, so three attempts would only spend the
    // caller's deadline before the fallback chain gets its turn.
    const createCompletion = vi.fn().mockRejectedValue(modelNotFound());

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = { completions: { create: createCompletion } };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    await expect(
      groqGenerateTextResponse({ apiKey: "k", model: "x", prompt: "hi" }),
    ).rejects.toThrow(/did not serve the model/);

    expect(createCompletion).toHaveBeenCalledTimes(1);
  });

  it("reports an unserved model without asserting it was retired", async () => {
    const createCompletion = vi.fn().mockRejectedValue(modelNotFound());

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = { completions: { create: createCompletion } };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse, GroqModelUnavailableError } =
      await import("../src/groq.utils");

    // The provider body is ambiguous: "does not exist or you do not have
    // access to it". An organisation without entitlement gets a 404, not a
    // 403, so calling this a retirement would misdiagnose a live access
    // failure. The message has to name the id and stay neutral on the cause.
    const error = await groqGenerateTextResponse({
      apiKey: "k",
      model: "x",
      prompt: "hi",
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GroqModelUnavailableError);
    expect((error as Error).message).toContain("did not serve the model `x`");
    expect((error as Error).message).toContain(
      "retired, renamed, or not enabled for your account",
    );
    expect((error as Error).message).not.toMatch(/has retired or renamed it/);
  });

  it("redacts a Groq gsk_ key echoed by a 401 instead of leaking it", async () => {
    const createCompletion = vi.fn().mockRejectedValue(
      Object.assign(new Error(`Incorrect API key provided: ${FAKE_KEY}`), {
        status: 401,
      }),
    );

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = { completions: { create: createCompletion } };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    const error = await groqGenerateTextResponse({
      apiKey: FAKE_KEY,
      model: "x",
      prompt: "hi",
    }).catch((thrown: unknown) => thrown as Error);

    expect(error.message).not.toMatch(/gsk_[A-Za-z0-9]/);
    expect(error.message).toContain("[redacted]");
  });
});

describe("redactGroqMessage", () => {
  it("redacts a Groq key without matching an ordinary hyphenated word", async () => {
    const { redactGroqMessage } = await import("../src/groq.utils");

    expect(redactGroqMessage("key " + "gsk_" + "liveAbCd1234 used")).toBe(
      "key [redacted] used",
    );
    expect(redactGroqMessage("ticket task-123 is open")).toBe(
      "ticket task-123 is open",
    );
  });

  it("redacts the other providers' key prefixes from a Groq message", async () => {
    // The shared list is used verbatim by Cerebras. A Groq proxy that replays
    // the credential it was handed as a Cerebras-shaped token still has to be
    // scrubbed, which is the whole point of one shared list.
    const { redactGroqMessage } = await import("../src/groq.utils");

    expect(redactGroqMessage("csk_" + "liveAbCd1234")).toBe("[redacted]");
    expect(redactGroqMessage("sk-" + "liveAbCd1234")).toBe("[redacted]");
    expect(redactGroqMessage("sk_" + "liveAbCd1234")).toBe("[redacted]");
  });

  it("redacts the hyphenated form of the Groq prefix", async () => {
    // Coverage gained by delegating to the shared scrubber rather than
    // refactoring a local list. The four private patterns this replaced matched
    // `gsk_`, `csk_`, `sk-` and `sk_` and nothing else, so a `gsk-` token fell
    // through every one of them and into the log. The shared pattern is a
    // single alternation over the three prefixes followed by `-` or `_`.
    const { redactGroqMessage } = await import("../src/groq.utils");

    expect(redactGroqMessage("gsk-" + "liveAbCd1234")).toBe("[redacted]");
    expect(redactGroqMessage("csk-" + "liveAbCd1234")).toBe("[redacted]");
  });

  it("redacts a bare Bearer token a proxy echoed into the body", async () => {
    const { redactGroqMessage } = await import("../src/groq.utils");

    const redacted = redactGroqMessage("upstream said: bearer Abc_123xyz");
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("Abc_123xyz");
  });

  it("redacts an Authorization header a proxy echoed into the body", async () => {
    const { redactGroqMessage } = await import("../src/groq.utils");

    const redacted = redactGroqMessage(
      "request headers: Authorization: Bearer Abc_123xyz",
    );
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain("Abc_123xyz");
  });
});

describe("non-Error rejections", () => {
  it("keeps the thrown text of a string rejection instead of discarding it", async () => {
    const { normalizeGroqError } = await import("../src/groq.utils");

    // A string throw is not an `Error`, so the old `error.message` test failed
    // and the message degraded to "request failed", throwing away the only
    // description of what went wrong.
    const error = normalizeGroqError("socket hang up", "x");

    expect(error.message).toContain("socket hang up");
  });

  it("adds no status suffix when a non-Error throw carried no status", async () => {
    const { normalizeGroqError } = await import("../src/groq.utils");

    expect(normalizeGroqError("socket hang up", "x").message).not.toMatch(
      /with status/,
    );
  });

  it("appends the status when a non-Error throw carries one", async () => {
    const { normalizeGroqError } = await import("../src/groq.utils");

    const error = normalizeGroqError({ status: 503, detail: "upstream" }, "x");

    expect(error.message).toContain("with status 503");
  });

  it("redacts a key echoed by a non-Error throw", async () => {
    const { normalizeGroqError } = await import("../src/groq.utils");

    const error = normalizeGroqError(
      "upstream rejected " + "gsk_" + "liveAbCd1234",
      "x",
    );

    expect(error.message).not.toMatch(/gsk_[A-Za-z0-9]/);
    expect(error.message).toContain("[redacted]");
  });
});

describe("abort handling during the retry sleep", () => {
  // Regression: the abort branch used to test `signal.aborted` instead of the
  // error's own shape. `retry` sleeps 20ms between attempts and re-checks
  // `isRetryable`, which reads `signal.aborted`. A deadline that fires during
  // that sleep makes `retry` rethrow the *original* provider failure, so the
  // branch saw an aborted signal and passed a credential-echoing 5xx through
  // without ever reaching `redactGroqMessage`. The body landed in the
  // desktop log verbatim on exactly the path the redaction exists for.
  const ECHOING_KEY = "gsk_" + "liveAbCd1234";

  it("redacts a provider failure rethrown after the deadline fired", async () => {
    const controller = new AbortController();
    // Abort while `retry` is sleeping between the two attempts, so the
    // rethrown error is the provider failure, not an abort.
    const createCompletion = vi.fn().mockImplementation(async () => {
      if (createCompletion.mock.calls.length === 1) {
        controller.abort();
      }
      throw Object.assign(new Error(`upstream 503 rejected ${ECHOING_KEY}`), {
        status: 503,
      });
    });

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = { completions: { create: createCompletion } };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    const error = await groqGenerateTextResponse({
      apiKey: "test-key",
      model: "x",
      prompt: "hi",
      signal: controller.signal,
    }).catch((thrown: unknown) => thrown as Error);

    // Asserting only the throw type would pass against the defect: the
    // unredacted original and the redacted original are both Errors.
    expect(controller.signal.aborted).toBe(true);
    expect(error.message).not.toMatch(/gsk_[A-Za-z0-9]/);
    expect(error.message).toContain("[redacted]");
    expect(error.message).toContain("upstream 503");
  });

  it("still passes a genuine AbortError through untouched", async () => {
    const controller = new AbortController();
    controller.abort();

    const createCompletion = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );

    vi.resetModules();
    vi.doMock("groq-sdk/index", () => ({
      default: class MockGroq {
        chat = { completions: { create: createCompletion } };
      },
      toFile: vi.fn(),
    }));

    const { groqGenerateTextResponse } = await import("../src/groq.utils");

    const error = await groqGenerateTextResponse({
      apiKey: "test-key",
      model: "x",
      prompt: "hi",
      signal: controller.signal,
    }).catch((thrown: unknown) => thrown as Error);

    // Callers recognize an abort by its own shape, so the pass-through has to
    // keep that shape rather than hand back a normalized provider error.
    expect(error.name).toBe("AbortError");
  });
});

const runGroqRequestCase = async (model: string) => {
  const createCompletion = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
    usage: { total_tokens: 5 },
  });

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

  await groqGenerateTextResponse({
    apiKey: "test-key",
    model,
    prompt: "hi",
    jsonResponse: {
      name: "schema",
      description: "x",
      schema: { type: "object" as const, properties: {} },
    },
  });

  return createCompletion.mock.calls[0][0];
};

describe("groqGenerateTextResponse reasoning controls", () => {
  afterEach(() => {
    vi.doUnmock("groq-sdk/index");
    vi.resetModules();
  });

  it("asks GPT-OSS models for low-effort reasoning with the channel hidden", async () => {
    // GPT-OSS defaults to medium effort, and JSON mode rejects the raw
    // reasoning format, so a structured cleanup call must pick both.
    const call = await runGroqRequestCase("openai/gpt-oss-20b");

    expect(call).toMatchObject({
      reasoning_effort: "low",
      reasoning_format: "hidden",
    });
  });

  it("sends no reasoning params for models without a reasoning channel", async () => {
    const call = await runGroqRequestCase("qwen/qwen3.6-27b");

    expect(call).not.toHaveProperty("reasoning_effort");
    expect(call).not.toHaveProperty("reasoning_format");
  });
});
