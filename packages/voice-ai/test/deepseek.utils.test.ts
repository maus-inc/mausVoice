import { createOpenAICompatibleGenerateTests } from "./shared-openai-compat-generate.test";

createOpenAICompatibleGenerateTests({
  describeName: "deepseekGenerateTextResponse",
  importPath: "../src/deepseek.utils",
  functionName: "deepseekGenerateTextResponse",
  defaultModel: "deepseek-chat",
});
