import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "azureOpenAIGenerateText",
  loadModule: async () => {
    const mod = await import("../src/azure-openai.utils");
    return mod;
  },
  functionName: "azureOpenAIGenerateText",
  defaultModel: "gpt-4o-mini",
  expectedJsonResponseType: "json_schema",
  extraParams: {
    endpoint: "https://test.azure.com",
    deploymentName: "gpt-4o-mini",
  },
});
