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

describe("GenerateTextInput.maxTokens forwarding", () => {
  const forwardingCases: [
    name: string,
    build: () => {
      generateText: (i: {
        prompt: string;
        maxTokens?: number;
      }) => Promise<unknown>;
    },
    spy: () => ReturnType<typeof vi.fn>,
  ][] = [
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
        new OpenAICompatibleGenerateTextRepo(
          "https://example.com",
          "model",
          "k",
        ),
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

  it.each(forwardingCases)(
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

    const repo = new GroqGenerateTextRepo("k", "openai/gpt-oss-20b");
    const output = await repo.generateText({ prompt: "p" });

    expect(output.metadata?.model).toBe("qwen/qwen3.6-27b");
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
