import { afterEach, describe, expect, it, vi } from "vitest";
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

const AZURE_JSON_SCHEMA = {
  name: "schema",
  description: "x",
  schema: {
    type: "object" as const,
    properties: { result: { type: "string" as const } },
    required: ["result"],
  },
};

describe("azureOpenAIGenerateText deployment coverage", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  const mockAzureCreate = (create: ReturnType<typeof vi.fn>) => {
    vi.doMock("openai", () => ({
      AzureOpenAI: class MockAzureOpenAI {
        chat = {
          completions: {
            create,
          },
        };
      },
      default: class MockOpenAI {
        chat = {
          completions: {
            create,
          },
        };
      },
    }));
  };

  // User-deployed models (Llama, Phi, ...) are not in the Azure allow-list, so
  // the request must use json_object or the provider rejects it outright.
  it.each([
    [
      "falls back to json_object for deployments without json_schema support",
      "llama-3.3-70b",
      "json_object",
    ],
    [
      "uses json_schema for a supported deployment",
      "gpt-4o-mini",
      "json_schema",
    ],
  ] as const)("%s", async (_title, deploymentName, responseType) => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockAzureCreate(create);

    const { azureOpenAIGenerateText } =
      await import("../src/azure-openai.utils");

    await azureOpenAIGenerateText({
      apiKey: "test-key",
      endpoint: "https://test.azure.com",
      deploymentName,
      prompt: "hi",
      jsonResponse: AZURE_JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: deploymentName,
      response_format: { type: responseType },
    });
  });
});

describe("azureOpenAITestIntegration", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  it("reports the endpoint usable when models.list succeeds", async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    vi.doMock("openai", () => ({
      AzureOpenAI: class MockAzureOpenAI {
        models = { list };
      },
      default: class MockOpenAI {},
    }));

    const { azureOpenAITestIntegration } =
      await import("../src/azure-openai.utils");

    await expect(
      azureOpenAITestIntegration({
        apiKey: "test-key",
        endpoint: "https://test.azure.com",
      }),
    ).resolves.toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("propagates a connectivity failure from models.list", async () => {
    const list = vi.fn().mockRejectedValue(new Error("endpoint unreachable"));
    vi.doMock("openai", () => ({
      AzureOpenAI: class MockAzureOpenAI {
        models = { list };
      },
      default: class MockOpenAI {},
    }));

    const { azureOpenAITestIntegration } =
      await import("../src/azure-openai.utils");

    await expect(
      azureOpenAITestIntegration({
        apiKey: "test-key",
        endpoint: "https://test.azure.com",
      }),
    ).rejects.toThrow("endpoint unreachable");
  });
});

import { createJsonResponseFormatTests } from "../src/test-helpers/shared-json-response-format.helper";

createJsonResponseFormatTests({
  describeName: "azureOpenAIGenerateText deployment format selection",
  loadModule: async () => {
    const mod = await import("../src/azure-openai.utils");
    return mod;
  },
  functionName: "azureOpenAIGenerateText",
  jsonObjectModels: ["gpt-4", "llama-3.3-70b"],
  jsonSchemaModels: ["gpt-4o-mini"],
  extraParams: { endpoint: "https://test.azure.com" },
  modelParamName: "deploymentName",
});
