import { afterEach, describe, expect, it, vi } from "vitest";

describe("openrouterGenerateTextResponse", () => {
  afterEach(() => {
    vi.doUnmock("openai");
    vi.resetModules();
  });

  it("uses the hardcoded max_tokens when maxTokens is undefined", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ result: "ok" }),
          },
        },
      ],
      usage: {
        total_tokens: 5,
      },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_tokens: 1024,
    });
  });

  it("forwards caller-owned maxTokens to max_tokens when provided", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({ result: "ok" }),
          },
        },
      ],
      usage: {
        total_tokens: 5,
      },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      prompt: "hello",
      maxTokens: 600,
    });

    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      max_tokens: 600,
    });
  });

  it("uses json_schema for OpenAI models on OpenRouter", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      model: "openai/gpt-4o-mini",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      model: "openai/gpt-4o-mini",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: jsonResponse.name,
          description: jsonResponse.description,
          schema: jsonResponse.schema,
          strict: true,
        },
      },
    });
  });

  it("falls back to json_object for non-OpenAI models on OpenRouter", async () => {
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { total_tokens: 5 },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = {
          completions: {
            create: createCompletion,
          },
        };
      },
    }));

    const { openrouterGenerateTextResponse } =
      await import("../src/openrouter.utils");

    const jsonResponse = {
      name: "schema",
      description: "x",
      schema: {
        type: "object" as const,
        properties: { result: { type: "string" as const } },
        required: ["result"],
      },
    };

    await openrouterGenerateTextResponse({
      apiKey: "test-key",
      model: "anthropic/claude-3.5-sonnet",
      prompt: "hi",
      jsonResponse,
    });

    expect(createCompletion.mock.calls[0][0]).toMatchObject({
      model: "anthropic/claude-3.5-sonnet",
      response_format: { type: "json_object" },
    });
  });
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
