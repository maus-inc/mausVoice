import { vi } from "vitest";
import { createGeminiGenerateTests } from "../src/test-helpers/shared-gemini-generate.helper";

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };
  },
  Type: { STRING: "string" },
}));

createGeminiGenerateTests({
  describeName: "geminiGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/gemini.utils");
    return mod;
  },
  functionName: "geminiGenerateTextResponse",
  generateContentMock,
});
