import { describe, expect, it } from "vitest";
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
  expectedJsonResponseType: "json_schema",
});

describe("supportsOpenAIJsonSchema", () => {
  it("supports json_schema for all OPENAI_GENERATE_TEXT_MODELS", async () => {
    const { supportsOpenAIJsonSchema } = await import("../src/openai.utils");

    for (const model of OPENAI_GENERATE_TEXT_MODELS) {
      expect(supportsOpenAIJsonSchema(model)).toBe(true);
    }
  });
});

import { createJsonResponseFormatTests } from "../src/test-helpers/shared-json-response-format.helper";

createJsonResponseFormatTests({
  describeName: "openaiGenerateTextResponse response_format selection",
  loadModule: async () => {
    const mod = await import("../src/openai.utils");
    return mod;
  },
  functionName: "openaiGenerateTextResponse",
  jsonObjectModels: [
    "gpt-4-turbo",
    "gpt-3.5-turbo",
    "gpt-4-1106-preview",
    "gpt-4-turbo-preview",
    "gpt-4-0314",
    "gpt-3.5-turbo-16k",
    "gpt-4-vision-preview",
  ],
  jsonSchemaModels: [
    "o3-mini",
    "gpt-4o-mini",
    "gpt-4o-2024-08-06",
    "gpt-5-mini",
  ],
});
