import { afterEach, describe, expect, it, vi } from "vitest";
import {
  azureOpenAIGenerateText,
  CEREBRAS_MODELS,
  cerebrasGenerateTextResponse,
  CLAUDE_MODELS,
  claudeGenerateTextResponse,
  DEEPSEEK_MODELS,
  deepseekGenerateTextResponse,
  GEMINI_GENERATE_TEXT_MODELS,
  geminiGenerateTextResponse,
  GENERATE_TEXT_MODELS,
  GROQ_DEFAULT_GENERATE_TEXT_MODEL,
  groqGenerateTextResponse,
  OPENAI_GENERATE_TEXT_MODELS,
  openaiGenerateTextResponse,
  openrouterGenerateTextResponse,
} from "@maus-inc/voice-ai";
import {
  AzureOpenAIGenerateTextRepo,
  CerebrasGenerateTextRepo,
  ClaudeGenerateTextRepo,
  DeepseekGenerateTextRepo,
  GeminiGenerateTextRepo,
  GroqGenerateTextFallbackError,
  GroqGenerateTextRepo,
  OpenAIGenerateTextRepo,
  OpenAICompatibleGenerateTextRepo,
  OpenRouterGenerateTextRepo,
} from "./generate-text.repo";

vi.mock("@maus-inc/voice-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@maus-inc/voice-ai")>();
  return {
    ...actual,
    groqGenerateTextResponse: vi.fn(),
    openaiGenerateTextResponse: vi.fn(),
    openrouterGenerateTextResponse: vi.fn(),
    azureOpenAIGenerateText: vi.fn(),
    cerebrasGenerateTextResponse: vi.fn(),
    deepseekGenerateTextResponse: vi.fn(),
    geminiGenerateTextResponse: vi.fn(),
    claudeGenerateTextResponse: vi.fn(),
  };
});

const mockResponse = (text: string) => ({ text, tokensUsed: 1 });

afterEach(() => {
  vi.clearAllMocks();
});

type ProviderCase = [
  name: string,
  build: () => {
    generateText: (i: {
      prompt: string;
      maxTokens?: number;
      signal?: AbortSignal;
    }) => Promise<unknown>;
  },
  spy: () => ReturnType<typeof vi.fn>,
];

const providerCases: ProviderCase[] = [
  [
    "Groq",
    () => new GroqGenerateTextRepo("k", null),
    () => vi.mocked(groqGenerateTextResponse),
  ],
  [
    "OpenAI",
    () => new OpenAIGenerateTextRepo("k", null),
    () => vi.mocked(openaiGenerateTextResponse),
  ],
  [
    "OpenAI-compatible",
    () =>
      new OpenAICompatibleGenerateTextRepo("https://example.com", "model", "k"),
    () => vi.mocked(openaiGenerateTextResponse),
  ],
  [
    "OpenRouter",
    () => new OpenRouterGenerateTextRepo("k", null),
    () => vi.mocked(openrouterGenerateTextResponse),
  ],
  [
    "Azure OpenAI",
    () =>
      new AzureOpenAIGenerateTextRepo(
        "k",
        "https://example.azure.com",
        "gpt-4o-mini",
      ),
    () => vi.mocked(azureOpenAIGenerateText),
  ],
  [
    "Cerebras",
    () => new CerebrasGenerateTextRepo("k", null),
    () => vi.mocked(cerebrasGenerateTextResponse),
  ],
  [
    "Deepseek",
    () => new DeepseekGenerateTextRepo("k", null),
    () => vi.mocked(deepseekGenerateTextResponse),
  ],
  [
    "Gemini",
    () => new GeminiGenerateTextRepo("k", null),
    () => vi.mocked(geminiGenerateTextResponse),
  ],
  [
    "Claude",
    () => new ClaudeGenerateTextRepo("k", null),
    () => vi.mocked(claudeGenerateTextResponse),
  ],
];

describe("GenerateTextInput.maxTokens forwarding", () => {
  it.each(providerCases)(
    "%s forwards maxTokens to the underlying call",
    async (_name, build, spy) => {
      const mocked = spy();
      mocked.mockResolvedValue(mockResponse("hi"));

      await build().generateText({ prompt: "p", maxTokens: 600 });

      expect(mocked).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 600 }),
      );
    },
  );

  it("passes maxTokens: undefined to the underlying call when the caller omits it (preserves provider defaults)", async () => {
    vi.mocked(groqGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p" });

    const call = vi.mocked(groqGenerateTextResponse).mock.calls[0][0];
    expect(call.maxTokens).toBeUndefined();
  });
});

describe("GenerateTextInput.signal forwarding", () => {
  it.each(providerCases)(
    "%s forwards the caller's abort signal to the provider request",
    async (_name, build, spy) => {
      const mocked = spy();
      mocked.mockResolvedValue(mockResponse("hi"));

      const controller = new AbortController();
      await build().generateText({
        prompt: "p",
        signal: controller.signal,
      });

      expect(mocked).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
    },
  );

  it("Groq does not fall back to the backup model when the caller aborted", async () => {
    const mocked = vi.mocked(groqGenerateTextResponse);
    mocked.mockRejectedValueOnce(new Error("boom"));

    const controller = new AbortController();
    controller.abort();

    // Pin the primary to 120b so the fallback resolves to 20b. That is not
    // what makes the test pass: `mockRejectedValueOnce` leaves the second call
    // resolving undefined, so removing the abort guard makes `response.text`
    // throw and this expectation fail for either model. The distinct model is
    // here so the test reads as what it checks, the abort path.
    const repo = new GroqGenerateTextRepo("k", "openai/gpt-oss-120b");
    await expect(
      repo.generateText({ prompt: "p", signal: controller.signal }),
    ).rejects.toThrow("boom");

    // The abort is the caller's deadline decision: retrying (or falling back
    // to a second model) would burn quota after the deadline already fired.
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe("Groq fallback model", () => {
  // Regression: the Groq fallback used to point at a retired id, so a primary
  // failure turned into a hard 404 instead of a working second attempt.
  it("retries the primary 120b failure on the 20b model", async () => {
    const mocked = vi.mocked(groqGenerateTextResponse);
    mocked.mockRejectedValueOnce(new Error("primary down"));
    mocked.mockResolvedValueOnce(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo("k", "openai/gpt-oss-120b");
    await repo.generateText({ prompt: "p" });

    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[1]![0]!.model).toBe(
      GROQ_DEFAULT_GENERATE_TEXT_MODEL,
    );
  });

  // Regression: the default model used to be the same id as the fallback, so
  // a default-model failure rethrew without ever trying the other live model.
  it("retries a distinct model when the default model fails", async () => {
    const mocked = vi.mocked(groqGenerateTextResponse);
    mocked.mockRejectedValueOnce(new Error("primary down"));
    mocked.mockResolvedValueOnce(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo(
      "k",
      GROQ_DEFAULT_GENERATE_TEXT_MODEL,
    );
    await repo.generateText({ prompt: "p" });

    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[0]![0]!.model).toBe(
      GROQ_DEFAULT_GENERATE_TEXT_MODEL,
    );
    expect(mocked.mock.calls[1]![0]!.model).toBe("openai/gpt-oss-120b");
  });

  it("retries a distinct model when no model is stored", async () => {
    const mocked = vi.mocked(groqGenerateTextResponse);
    mocked.mockRejectedValueOnce(new Error("primary down"));
    mocked.mockResolvedValueOnce(mockResponse("hi"));

    // No stored model resolves to the default; a failure must still retry.
    const repo = new GroqGenerateTextRepo("k", null);
    const output = await repo.generateText({ prompt: "p" });

    expect(mocked).toHaveBeenCalledTimes(2);
    expect(output.metadata?.model).toBe("openai/gpt-oss-120b");
  });

  // An account-scoped rejection fails identically on every model, so a second
  // request chain only delays surfacing the real problem.
  it.each([400, 401, 402, 403])(
    "does not try a second model after an account-scoped %i",
    async (status) => {
      const mocked = vi.mocked(groqGenerateTextResponse);
      mocked.mockRejectedValue(Object.assign(new Error("nope"), { status }));

      const repo = new GroqGenerateTextRepo("k", null);
      await expect(repo.generateText({ prompt: "p" })).rejects.toThrow("nope");

      expect(mocked).toHaveBeenCalledTimes(1);
    },
  );

  it.each([404, 429, 500, 503])(
    "still tries a second model after a retryable-model %i",
    async (status) => {
      const mocked = vi.mocked(groqGenerateTextResponse);
      mocked.mockRejectedValueOnce(
        Object.assign(new Error("transient"), { status }),
      );
      mocked.mockResolvedValueOnce(mockResponse("hi"));

      const repo = new GroqGenerateTextRepo("k", null);
      const output = await repo.generateText({ prompt: "p" });

      expect(mocked).toHaveBeenCalledTimes(2);
      expect(output.metadata?.model).toBe("openai/gpt-oss-120b");
    },
  );

  it("names both models and both causes when the fallback also fails", async () => {
    // Reporting only the second error made a retired fallback look exactly
    // like the configured model failing alone.
    const mocked = vi.mocked(groqGenerateTextResponse);
    mocked
      .mockRejectedValueOnce(new Error("primary model exploded"))
      .mockRejectedValueOnce(new Error("fallback model is retired"));

    const repo = new GroqGenerateTextRepo("k", null);
    const error = await repo
      .generateText({ prompt: "p" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GroqGenerateTextFallbackError);
    const fallbackError = error as InstanceType<
      typeof GroqGenerateTextFallbackError
    >;
    expect(fallbackError.primaryModel).toBe("openai/gpt-oss-20b");
    expect(fallbackError.fallbackModel).toBe("openai/gpt-oss-120b");
    expect(fallbackError.message).toContain("primary model exploded");
    expect(fallbackError.message).toContain("fallback model is retired");
    expect(fallbackError.message).toContain("openai/gpt-oss-20b");
    expect(fallbackError.message).toContain("openai/gpt-oss-120b");
  });

  it("tells the user to change the model when a cause is model-scoped", async () => {
    const mocked = vi.mocked(groqGenerateTextResponse);
    // The provider body Groq sends for a model it did not serve. It is
    // ambiguous, but the status is what the repo keys the model-scoped
    // decision on, the same way the provider does.
    mocked
      .mockRejectedValueOnce(
        Object.assign(
          new Error("The model `x` does not exist or you do not have access to it."),
          { status: 404 },
        ),
      )
      .mockRejectedValueOnce(
        Object.assign(
          new Error("The model `y` does not exist or you do not have access to it."),
          { status: 404 },
        ),
      );

    const repo = new GroqGenerateTextRepo("k", null);
    const error = await repo
      .generateText({ prompt: "p" })
      .then(
        () => {
          throw new Error("expected the chain to fail");
        },
        (e: unknown) => e as Error,
      );

    expect(error.message).toContain(
      "Choose a different post-processing model in Settings.",
    );
  });

  it("tells the user to retry when both causes are transient", async () => {
    const mocked = vi.mocked(groqGenerateTextResponse);
    // A Groq incident returning 503 for both models. No setting change can
    // affect this, so the old unconditional Settings advice pointed at a
    // control that could not help.
    mocked
      .mockRejectedValueOnce(
        Object.assign(new Error("primary 503"), { status: 503 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("fallback 503"), { status: 503 }),
      );

    const repo = new GroqGenerateTextRepo("k", null);
    const error = await repo
      .generateText({ prompt: "p" })
      .then(
        () => {
          throw new Error("expected the chain to fail");
        },
        (e: unknown) => e as Error,
      );

    expect(error.message).not.toContain("Choose a different post-processing");
    expect(error.message).toContain("Retry the request.");
  });

  it("does not report a chain failure when the abort lands on the fallback", async () => {
    const controller = new AbortController();
    const mocked = vi.mocked(groqGenerateTextResponse);
    // The primary fails while the caller is still live, so the chain does
    // reach the second attempt; the deadline then expires on that attempt.
    mocked.mockRejectedValueOnce(new Error("primary failed"));
    mocked.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });

    const repo = new GroqGenerateTextRepo("k", null);
    const error = await repo
      .generateText({ prompt: "p", signal: controller.signal })
      .catch((e: unknown) => e);

    // The caller's deadline is not a chain failure and must stay recognizable.
    expect(error).not.toBeInstanceOf(GroqGenerateTextFallbackError);
    expect((error as Error).message).toBe("aborted");
  });
});

describe("default model fallback when no model is stored", () => {
  const cases: [
    name: string,
    build: () => { generateText: (i: { prompt: string }) => Promise<unknown> },
    spy: () => { mock: { calls: unknown[][] } },
    allowed: readonly string[],
  ][] = [
    [
      "Deepseek",
      () => new DeepseekGenerateTextRepo("k", null),
      () => vi.mocked(deepseekGenerateTextResponse),
      DEEPSEEK_MODELS,
    ],
    [
      "Claude",
      () => new ClaudeGenerateTextRepo("k", null),
      () => vi.mocked(claudeGenerateTextResponse),
      CLAUDE_MODELS,
    ],
    [
      "Cerebras",
      () => new CerebrasGenerateTextRepo("k", null),
      () => vi.mocked(cerebrasGenerateTextResponse),
      CEREBRAS_MODELS,
    ],
    [
      "Groq",
      () => new GroqGenerateTextRepo("k", null),
      () => vi.mocked(groqGenerateTextResponse),
      GENERATE_TEXT_MODELS,
    ],
    [
      "OpenAI",
      () => new OpenAIGenerateTextRepo("k", null),
      () => vi.mocked(openaiGenerateTextResponse),
      OPENAI_GENERATE_TEXT_MODELS,
    ],
    [
      "Gemini",
      () => new GeminiGenerateTextRepo("k", null),
      () => vi.mocked(geminiGenerateTextResponse),
      GEMINI_GENERATE_TEXT_MODELS,
    ],
  ];

  it.each(cases)(
    "%s falls back to a model the provider still supports",
    async (_name, build, spy, allowed) => {
      const mocked = spy() as unknown as {
        mockResolvedValue: (v: unknown) => void;
        mock: { calls: { model: string }[][] };
      };
      mocked.mockResolvedValue(mockResponse("hi"));

      await build().generateText({ prompt: "p" });

      expect(allowed).toContain(mocked.mock.calls[0]![0]!.model);
    },
  );
});

describe("generateText metadata reports the resolved model", () => {
  it("Groq reports the configured model on the happy path", async () => {
    vi.mocked(groqGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo("k", "openai/gpt-oss-20b");
    const output = await repo.generateText({ prompt: "p" });

    expect(output.metadata?.model).toBe("openai/gpt-oss-20b");
  });

  it("Groq reports the fallback model when the primary model fails", async () => {
    vi.mocked(groqGenerateTextResponse)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo("k", "openai/gpt-oss-120b");
    const output = await repo.generateText({ prompt: "p" });

    expect(output.metadata?.model).toBe(GROQ_DEFAULT_GENERATE_TEXT_MODEL);
  });

  it("Groq reports the other model when the default model fails", async () => {
    vi.mocked(groqGenerateTextResponse)
      .mockRejectedValueOnce(new Error("primary down"))
      .mockResolvedValueOnce(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo(
      "k",
      GROQ_DEFAULT_GENERATE_TEXT_MODEL,
    );
    const output = await repo.generateText({ prompt: "p" });

    expect(output.metadata?.model).toBe("openai/gpt-oss-120b");
  });

  it("OpenAI reports the configured model", async () => {
    vi.mocked(openaiGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const output = await new OpenAIGenerateTextRepo("k", null).generateText({
      prompt: "p",
    });

    expect(output.metadata?.model).toBe("gpt-4o-mini");
  });

  it("Gemini reports the configured model", async () => {
    vi.mocked(geminiGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const output = await new GeminiGenerateTextRepo(
      "k",
      "gemini-2.5-flash",
    ).generateText({ prompt: "p" });

    expect(output.metadata?.model).toBe("gemini-2.5-flash");
  });

  it("Azure reports the deployment name as the model", async () => {
    vi.mocked(azureOpenAIGenerateText).mockResolvedValue(mockResponse("hi"));

    const output = await new AzureOpenAIGenerateTextRepo(
      "k",
      "https://example.openai.azure.com",
      "my-deployment",
    ).generateText({ prompt: "p" });

    expect(output.metadata?.model).toBe("my-deployment");
  });
});

describe("OpenAICompatibleBaseGenerateTextRepo customFetch egress protection", () => {
  it("passes secureFetch as customFetch by default", async () => {
    const mocked = vi.mocked(openaiGenerateTextResponse);
    mocked.mockResolvedValue(mockResponse("custom fetch test"));

    const repo = new OpenAICompatibleGenerateTextRepo(
      "https://example.com/v1",
      "test-model",
      "test-key",
    );
    await repo.generateText({ prompt: "hello" });

    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        customFetch: expect.any(Function),
      }),
    );
  });

  it("passes an explicitly injected customFetch to the underlying provider call", async () => {
    const mocked = vi.mocked(openaiGenerateTextResponse);
    mocked.mockResolvedValue(mockResponse("custom fetch test"));

    const customFetchMock = vi.fn();
    const repo = new OpenAICompatibleGenerateTextRepo(
      "https://example.com/v1",
      "test-model",
      "test-key",
      customFetchMock as never,
    );
    await repo.generateText({ prompt: "hello" });

    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        customFetch: customFetchMock,
      }),
    );
  });
});
