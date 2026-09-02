import { describe, expect, it, vi } from "vitest";
import { OPENAI_GENERATE_TEXT_MODELS } from "../src/openai.utils";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "openaiGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/openai.utils");
    return mod;
  },
  functionName: "openaiGenerateTextResponse",
  defaultModel: "gpt-4o-mini",
});

describe("supportsOpenAIJsonSchema", () => {
  it("supports json_schema for all OPENAI_GENERATE_TEXT_MODELS", async () => {
    const { supportsOpenAIJsonSchema } = await import("../src/openai.utils");

    for (const model of OPENAI_GENERATE_TEXT_MODELS) {
      expect(supportsOpenAIJsonSchema(model)).toBe(true);
    }
  });
});
