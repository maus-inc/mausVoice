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
