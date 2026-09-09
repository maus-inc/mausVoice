import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleGenerateTests } from "../src/test-helpers/shared-openai-compat-generate.helper";

createOpenAICompatibleGenerateTests({
  describeName: "openrouterGenerateTextResponse",
  loadModule: async () => {
    const mod = await import("../src/openrouter.utils");
    return mod;
  },
  functionName: "openrouterGenerateTextResponse",
  defaultModel: "openai/gpt-4o-mini",
  expectedJsonResponseType: "json_schema",
  maxTokensKey: "max_tokens",
});

describe("openrouterTranscribeAudio", () => {
  const setupTranscriptionMock = (create: ReturnType<typeof vi.fn>) => {
    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create,
          },
        };
      },
      toFile: async (blob: ArrayBuffer | Buffer, name: string) => ({
        blob,
        name,
      }),
    }));
  };

  it("sends audio to the OpenRouter transcriptions endpoint via the OpenAI SDK", async () => {
    const create = vi.fn().mockResolvedValue({ text: "hello world" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    const result = await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    expect(result.text).toBe("hello world");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/whisper-1",
    });
  });

  it("forwards a non-auto language to the OpenAI SDK", async () => {
    const create = vi.fn().mockResolvedValue({ text: "你好" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(4),
      ext: "wav",
      language: "zh",
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({ language: "zh" });
  });

  it("omits language when the value is auto", async () => {
    const create = vi.fn().mockResolvedValue({ text: "hi" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await openrouterTranscribeAudio({
      apiKey: "test-key",
      model: "openai/whisper-1",
      blob: new ArrayBuffer(4),
      ext: "wav",
      language: "auto",
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      language: undefined,
    });
  });

  it("throws when the response text is empty", async () => {
    const create = vi.fn().mockResolvedValue({ text: "" });
    setupTranscriptionMock(create);

    const { openrouterTranscribeAudio } =
      await import("../src/openrouter.utils");

    await expect(
      openrouterTranscribeAudio({
        apiKey: "test-key",
        model: "openai/whisper-1",
        blob: new ArrayBuffer(4),
        ext: "wav",
      }),
    ).rejects.toThrow("Transcription failed");
  });
});

describe("openrouterGenerateTextResponse response_format selection", () => {
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

  it("sends json_object plus the JSON prompt hint for legacy openai/gpt-4-turbo", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      model: "openai/gpt-4-turbo",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/gpt-4-turbo",
      response_format: { type: "json_object" },
    });
    const content = userContent(create);
    expect(content).toContain("JSON");
    expect(content).toContain(JSON.stringify(JSON_SCHEMA.schema));
  });

  it("keeps json_schema for discovered modern models such as the o-series", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      model: "openai/o3-mini",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/o3-mini",
      response_format: { type: "json_schema" },
    });
    expect(userContent(create)).toBe("hi");
  });

  it("keeps json_schema for the curated favorite models", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });
    mockCreate(create);
    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      model: "openai/gpt-oss-20b",
      prompt: "hi",
      jsonResponse: JSON_SCHEMA,
    });

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: "openai/gpt-oss-20b",
      response_format: { type: "json_schema" },
    });
    expect(userContent(create)).toBe("hi");
  });
});
