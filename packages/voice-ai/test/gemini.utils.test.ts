import { createGeminiGenerateTests } from "../src/test-helpers/shared-gemini-generate.helper";

createGeminiGenerateTests({
  describeName: "geminiGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/gemini.utils");
    return mod;
  },
  functionName: "geminiGenerateTextResponse",
});
