import { createOpenAICompatibleGenerateTests } from "./shared-openai-compat-generate.test";

function buildAzureMockFactory() {
  return {
    AzureOpenAI: class MockAzureOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      };
    },
  };
}

createOpenAICompatibleGenerateTests({
  describeName: "azureOpenAIGenerateText",
  importPath: "../src/azure-openai.utils",
  functionName: "azureOpenAIGenerateText",
  defaultModel: "gpt-4o-mini",
  mockFactory: buildAzureMockFactory,
});
