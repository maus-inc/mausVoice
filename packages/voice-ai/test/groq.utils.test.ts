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
});

describe("retired model handling", () => {
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
    ).rejects.toThrow(/no longer serves/);

    expect(createCompletion).toHaveBeenCalledTimes(1);
  });

  it("reports a retired model as an actionable error naming the model and the setting", async () => {
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

    // The provider body says only "does not exist or you do not have access
    // to it", which names a model the user cannot change from a snackbar.
    await expect(
      groqGenerateTextResponse({ apiKey: "k", model: "x", prompt: "hi" }),
    ).rejects.toThrow(/Settings/);

    const error = await groqGenerateTextResponse({
      apiKey: "k",
      model: "x",
      prompt: "hi",
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GroqModelUnavailableError);
    expect(
      (error as InstanceType<typeof GroqModelUnavailableError>).model,
    ).toBe("x");
    expect((error as { status?: number }).status).toBe(404);
  });

  it("redacts a Groq gsk_ key echoed by a 401 instead of leaking it", async () => {
    const createCompletion = vi.fn().mockRejectedValue(
      Object.assign(new Error("Incorrect API key provided: " + FAKE_KEY), {
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
});
