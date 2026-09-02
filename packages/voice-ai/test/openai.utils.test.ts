import { describe, expect, it } from "vitest";
import { OPENAI_GENERATE_TEXT_MODELS } from "../src/openai.utils";
import { createOpenAICompatibleGenerateTests } from "./shared-openai-compat-generate.test";

createOpenAICompatibleGenerateTests({
  describeName: "openaiGenerateTextResponse",
  importPath: "../src/openai.utils",
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
