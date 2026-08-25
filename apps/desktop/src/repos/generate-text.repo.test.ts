import { afterEach, describe, expect, it, vi } from "vitest";
import {
  azureOpenAIGenerateText,
  cerebrasGenerateTextResponse,
  claudeGenerateTextResponse,
  deepseekGenerateTextResponse,
  geminiGenerateTextResponse,
  groqGenerateTextResponse,
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
  it("forwards maxTokens from GenerateTextInput to groqGenerateTextResponse", async () => {
    vi.mocked(groqGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(groqGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to openaiGenerateTextResponse (OpenAI repo)", async () => {
    vi.mocked(openaiGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new OpenAIGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(openaiGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to openaiGenerateTextResponse (OpenAI-compatible repo)", async () => {
    vi.mocked(openaiGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new OpenAICompatibleGenerateTextRepo(
      "https://example.com",
      "model",
      "k",
    );
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(openaiGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to openrouterGenerateTextResponse", async () => {
    vi.mocked(openrouterGenerateTextResponse).mockResolvedValue(
      mockResponse("hi"),
    );

    const repo = new OpenRouterGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(openrouterGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to azureOpenAIGenerateText", async () => {
    vi.mocked(azureOpenAIGenerateText).mockResolvedValue(mockResponse("hi"));

    const repo = new AzureOpenAIGenerateTextRepo(
      "k",
      "https://example.azure.com",
      "gpt-4o-mini",
    );
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(azureOpenAIGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to cerebrasGenerateTextResponse", async () => {
    vi.mocked(cerebrasGenerateTextResponse).mockResolvedValue(
      mockResponse("hi"),
    );

    const repo = new CerebrasGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(cerebrasGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to deepseekGenerateTextResponse", async () => {
    vi.mocked(deepseekGenerateTextResponse).mockResolvedValue(
      mockResponse("hi"),
    );

    const repo = new DeepseekGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(deepseekGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to geminiGenerateTextResponse", async () => {
    vi.mocked(geminiGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new GeminiGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(geminiGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("forwards maxTokens from GenerateTextInput to claudeGenerateTextResponse", async () => {
    vi.mocked(claudeGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new ClaudeGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p", maxTokens: 600 });

    expect(claudeGenerateTextResponse).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 600 }),
    );
  });

  it("passes maxTokens: undefined to the underlying call when the caller omits it (preserves provider defaults)", async () => {
    vi.mocked(groqGenerateTextResponse).mockResolvedValue(mockResponse("hi"));

    const repo = new GroqGenerateTextRepo("k", null);
    await repo.generateText({ prompt: "p" });

    const call = vi.mocked(groqGenerateTextResponse).mock.calls[0][0];
    expect(call.maxTokens).toBeUndefined();
  });
});
