import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_GENERATE_TEXT_MODELS } from "../src/openai.utils";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "openaiGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/openai.utils");
    return mod;
  },
  functionName: "openaiGenerateTextResponse",
  defaultModel: "gpt-4o-mini",
  expectedJsonResponseType: "json_schema",
});

describe("supportsOpenAIJsonSchema", () => {
  it("supports json_schema for all OPENAI_GENERATE_TEXT_MODELS", async () => {
    const { supportsOpenAIJsonSchema } = await import("../src/openai.utils");

    for (const model of OPENAI_GENERATE_TEXT_MODELS) {
      expect(supportsOpenAIJsonSchema(model)).toBe(true);
    }
  });
});

describe("openaiGenerateTextResponse response_format selection", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  const JSON_SCHEMA = {
    name: "schema",
    description: "x",
    schema: {
      type: "object" as const,
      properties: { result: { type: "string" as const } },
      required: ["result"],
    },
  };

  const mockCreate = (create: ReturnType<typeof vi.fn>) => {
    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = { completions: { create } };
      },
      toFile: async (blob: ArrayBuffer | Buffer, name: string) => ({
        blob,
        name,
      }),
    }));
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
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => part.text).join(" ");
    }
    return "";
  };

  it("sends json_object plus the JSON prompt hint for legacy gpt-4-turbo", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "gpt-4-turbo",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-4-turbo",
      response_format: { type: "json_object" },
    });
    // The OpenAI API rejects json_object requests whose context never
    // mentions "JSON", so the schema instruction must be appended.
    const content = userContent(create);
    expect(content).toContain("JSON");
    expect(content).toContain(JSON.stringify(JSON_SCHEMA.schema));
  });

  it("sends json_object plus the JSON prompt hint for legacy gpt-3.5-turbo", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "gpt-3.5-turbo",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(userContent(create)).toContain("JSON");
  });

  it("keeps json_schema for discovered modern models such as the o-series", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "o3-mini",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    // The o-series rejects json_object outright; unknown modern models must
    // default to json_schema, not the legacy shape.
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "o3-mini",
      response_format: { type: "json_schema" },
    });
    expect(userContent(create)).toBe("hi");
  });

  it("keeps the prompt untouched for json_schema models", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openaiGenerateTextResponse } = await import("../src/openai.utils");

    await openaiGenerateTextResponse({
      apiKey: "test-key",
      model: "gpt-4o-mini",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      response_format: { type: "json_schema" },
    });
    expect(userContent(create)).toBe("hi");
  });
});
