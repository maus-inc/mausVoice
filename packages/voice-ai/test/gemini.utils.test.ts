import { afterEach, describe, expect, it, vi } from "vitest";

describe("geminiGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("@google/genai");
    vi.resetModules();
  });

  it("omits maxOutputTokens from the config when maxTokens is undefined", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: "ok",
      usageMetadata: { totalTokenCount: 1 },
    });

    vi.resetModules();
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class MockGoogleGenAI {
        models = {
          generateContent,
        };
      },
      Type: { STRING: "string" },
    }));

    const { geminiGenerateTextResponse } = await import("../src/gemini.utils");

    await geminiGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const params = generateContent.mock.calls[0][0];
    expect(params.config).toBeUndefined();
  });

  it("forwards caller-owned maxTokens to config.maxOutputTokens when provided", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: "ok",
      usageMetadata: { totalTokenCount: 1 },
    });

    vi.resetModules();
    vi.doMock("@google/genai", () => ({
      GoogleGenAI: class MockGoogleGenAI {
        models = {
          generateContent,
        };
      },
      Type: { STRING: "string" },
    }));

    const { geminiGenerateTextResponse } = await import("../src/gemini.utils");

    await geminiGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
      maxTokens: 600,
    });

    expect(generateContent).toHaveBeenCalledTimes(1);
    const params = generateContent.mock.calls[0][0];
    expect(params.config).toMatchObject({ maxOutputTokens: 600 });
  });
});
