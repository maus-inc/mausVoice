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

/**
 * The `openai` module mock every chat-completions suite in this file needs.
 *
 * Both the Azure client and the default export get the same `create` because
 * either one can be the constructor the module under test picks, and a change
 * to the mock's shape then has to be made once here rather than in each
 * describe that happened to declare its own copy.
 */
const mockChatCompletions = (create: ReturnType<typeof vi.fn>) => {
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

describe("azureOpenAIGenerateText deployment coverage", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

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
    mockChatCompletions(create);

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
  // Deployment names are user-chosen aliases: case variants of canonical
  // names and the frozen "-preview" snapshot names must all get the legacy
  // json_object shape (json_schema 400s on those frozen models).
  jsonObjectModels: [
    "gpt-4",
    "GPT-4",
    "Gpt-4-Turbo",
    "gpt-4-1106-preview",
    "gpt-4-0125-preview",
    "gpt-4-turbo-preview",
    "gpt-4-vision-preview",
    "gpt-35-turbo",
    "GPT-35-TURBO",
    "llama-3.3-70b",
  ],
  jsonSchemaModels: ["gpt-4o-mini", "gpt-4o", "gpt-5-mini"],
  extraParams: { endpoint: "https://test.azure.com" },
  modelParamName: "deploymentName",
});

describe("azure-openai o-series parameters", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  // Azure serves the same o-series deployments that reject `temperature` as an
  // unsupported parameter, and it answers with HTTP 400 before generating
  // anything. A user who picked a reasoning deployment got no dictation and no
  // explanation, because the request never reached the model.
  const paramsFor = async (deploymentName: string) => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
      usage: { total_tokens: 5 },
    });
    // Each case needs a fresh module graph: `doMock` after the first import
    // would leave the module holding the previous case's mock.
    vi.resetModules();
    mockChatCompletions(create);
    const { azureOpenAIGenerateText } =
      await import("../src/azure-openai.utils");
    await azureOpenAIGenerateText({
      apiKey: "test-key",
      endpoint: "https://test.azure.com",
      deploymentName,
      prompt: "hi",
    });
    return create.mock.calls[0]?.[0] as Record<string, unknown>;
  };

  it.each([
    ["o1"],
    ["o1-mini"],
    ["o3-mini"],
    ["o4-mini"],
    ["o1-preview-2024-09-12"],
  ])("sends no temperature to %s", async (deploymentName) => {
    const params = await paramsFor(deploymentName);
    expect(params).not.toHaveProperty("temperature");
    expect(params).toMatchObject({ model: deploymentName });
  });

  it.each([["gpt-4o-mini"], ["gpt-4o"], ["gpt-5-mini"]])(
    "still sends temperature to %s",
    async (deploymentName) => {
      const params = await paramsFor(deploymentName);
      expect(params).toMatchObject({ temperature: 1 });
    },
  );
});
