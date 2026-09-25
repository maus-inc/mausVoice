import { describe, expect, it, vi } from "vitest";

describe("openaiTranscribeAudio response_format", () => {
  const models: Array<{
    model: "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe";
    expectedFormat: "verbose_json" | "json";
  }> = [
    { model: "whisper-1", expectedFormat: "verbose_json" },
    { model: "gpt-4o-transcribe", expectedFormat: "json" },
    { model: "gpt-4o-mini-transcribe", expectedFormat: "json" },
  ];

  it.each(models)(
    "requests $expectedFormat for $model",
    async ({ model, expectedFormat }) => {
      const createTranscription = vi.fn().mockResolvedValue({
        text: "hello world",
        segments: [{ text: "hello world", no_speech_prob: 0.1 }],
      });

      vi.resetModules();
      vi.doMock("openai", () => ({
        default: class MockOpenAI {
          audio = {
            transcriptions: {
              create: createTranscription,
            },
          };
        },
        toFile: vi.fn().mockResolvedValue({}),
      }));

      const { openaiTranscribeAudio } = await import("../src/openai.utils");

      const result = await openaiTranscribeAudio({
        apiKey: "test-key",
        model,
        blob: new ArrayBuffer(8),
        ext: "wav",
      });

      expect(createTranscription).toHaveBeenCalledTimes(1);
      expect(createTranscription.mock.calls[0][0]).toMatchObject({
        model,
        response_format: expectedFormat,
      });
      expect(result.text).toBe("hello world");
      expect(result.segments?.[0]?.noSpeechProb).toBe(0.1);

      vi.doUnmock("openai");
    },
  );

  it("does not send verbose_json to gpt-4o models (which 400 on it)", async () => {
    const createTranscription = vi.fn().mockResolvedValue({
      text: "hello world",
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        audio = {
          transcriptions: {
            create: createTranscription,
          },
        };
      },
      toFile: vi.fn().mockResolvedValue({}),
    }));

    const { openaiTranscribeAudio } = await import("../src/openai.utils");

    const result = await openaiTranscribeAudio({
      apiKey: "test-key",
      model: "gpt-4o-transcribe",
      blob: new ArrayBuffer(8),
      ext: "wav",
    });

    const format = createTranscription.mock.calls[0][0].response_format;
    expect(format).not.toBe("verbose_json");
    expect(result.segments).toBeUndefined();

    vi.doUnmock("openai");
  });
});
