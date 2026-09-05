import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "cerebrasGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/cerebras.utils");
    return mod;
  },
  functionName: "cerebrasGenerateTextResponse",
  defaultModel: "gpt-oss-120b",
  maxTokensKey: "max_tokens",
});
