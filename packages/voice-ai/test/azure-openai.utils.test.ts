import { vi } from "vitest";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

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
  loadModule: async () => {
    const mod = await import("../src/azure-openai.utils");
    return mod;
  },
  functionName: "azureOpenAIGenerateText",
  defaultModel: "gpt-4o-mini",
  mockFactory: buildAzureMockFactory,
});
