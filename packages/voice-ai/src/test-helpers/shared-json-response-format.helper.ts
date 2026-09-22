import { afterEach, describe, expect, it, vi } from "vitest";

const JSON_SCHEMA = {
  name: "schema",
  description: "x",
  schema: {
    type: "object" as const,
    properties: { result: { type: "string" as const } },
    required: ["result"],
  },
};

/**
 * Regression coverage for the json_object/json_schema selection shared by
 * the OpenAI-compatible generate paths: legacy models must receive the
 * `json_object` shape with the "JSON" schema instruction appended to the
 * prompt (the API rejects json_object contexts that never mention JSON),
 * while every modern/discovered model must receive `json_schema` with the
 * prompt left untouched.
 */
export function createJsonResponseFormatTests({
  describeName,
  loadModule,
  functionName,
  jsonObjectModels,
  jsonSchemaModels,
  extraParams = {},
  modelParamName = "model",
}: {
  describeName: string;
  loadModule: () => Promise<Record<string, unknown>>;
  functionName: string;
  jsonObjectModels: string[];
  jsonSchemaModels: string[];
  extraParams?: Record<string, unknown>;
  /** Generate functions accept the model id under different names. */
  modelParamName?: string;
}): void {
  describe(describeName, () => {
    afterEach(() => {
      vi.doUnmock("openai");
      vi.resetModules();
    });

    const mockCreate = (create: ReturnType<typeof vi.fn>) => {
      vi.resetModules();
      vi.doMock("openai", () => ({
        default: class MockOpenAI {
          chat = { completions: { create } };
        },
        AzureOpenAI: class MockAzureOpenAI {
          chat = { completions: { create } };
        },
        toFile: async (blob: ArrayBuffer | Buffer, name: string) => ({
          blob,
          name,
        }),
      }));
    };

    const runGenerate = async (model: string) => {
      const create = vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
        usage: { total_tokens: 5 },
      });
      mockCreate(create);
      const mod = await loadModule();
      const fn = mod[functionName] as (
        params: Record<string, unknown>,
      ) => Promise<unknown>;
      await fn({
        apiKey: "test-key",
        [modelParamName]: model,
        prompt: "hi",
        jsonResponse: JSON_SCHEMA,
        ...extraParams,
      });
      return create;
    };

    const userContent = (create: ReturnType<typeof vi.fn>): string => {
      const call = create.mock.calls[0]?.[0] as {
        messages: Array<{
          role: string;
          content: string | Array<{ type: string; text: string }>;
        }>;
      };
      const user = call.messages.find((message) => message.role === "user");
      const content = user?.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content.map((part) => part.text).join(" ");
      }
      return "";
    };

    it.each(jsonObjectModels.map((model) => [model]))(
      "sends json_object plus the JSON prompt hint for %s",
      async (model) => {
        const create = await runGenerate(model);
        expect(create.mock.calls[0]?.[0]).toMatchObject({
          model,
          response_format: { type: "json_object" },
        });
        // The OpenAI API rejects json_object requests whose context never
        // mentions "JSON", so the schema instruction must be appended.
        const content = userContent(create);
        expect(content).toContain("JSON");
        expect(content).toContain(JSON.stringify(JSON_SCHEMA.schema));
      },
    );

    it.each(jsonSchemaModels.map((model) => [model]))(
      "keeps json_schema and leaves the prompt untouched for %s",
      async (model) => {
        const create = await runGenerate(model);
        expect(create.mock.calls[0]?.[0]).toMatchObject({
          model,
          response_format: { type: "json_schema" },
        });
        expect(userContent(create)).toBe("hi");
      },
    );
  });
}
