import { createOpenAICompatibleGenerateTests } from "./shared-openai-compat-generate.test";

createOpenAICompatibleGenerateTests({
  describeName: "cerebrasGenerateTextResponse",
  importPath: "../src/cerebras.utils",
  functionName: "cerebrasGenerateTextResponse",
  defaultModel: "llama3.1-8b",
});
