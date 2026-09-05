import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "deepseekGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/deepseek.utils");
    return mod;
  },
  functionName: "deepseekGenerateTextResponse",
  defaultModel: "deepseek-v4-flash",
  maxTokensKey: "max_tokens",
});
