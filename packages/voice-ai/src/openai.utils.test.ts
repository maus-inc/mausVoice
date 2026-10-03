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

describe("openaiGenerateTextResponse sampling parameters", () => {
  const generateTextParams = async (
    model: string,
  ): Promise<Record<string, unknown>> => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "rewritten" } }],
      usage: { total_tokens: 4 },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = { completions: { create } };
      },
      toFile: vi.fn().mockResolvedValue({}),
    }));

    const { openaiGenerateTextResponse } = await import("../src/openai.utils");
    const result = await openaiGenerateTextResponse({
      apiKey: "test-key",
      model,
      prompt: "hi",
    });

    expect(result.text).toBe("rewritten");
    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0] as Record<string, unknown>;
    vi.doUnmock("openai");
    return params;
  };

  // The o-series rejects `temperature` as an unsupported parameter rather than
  // ignoring it, so a discovered o-series id -- which this endpoint accepts,
  // because the model list is what the app offers -- answered every request
  // with a 400 before generating a single token. `top_p` goes with it: the same
  // documentation lists both as unsupported on those models.
  it.each(["o1", "o1-mini", "o3-mini", "o4-mini", "o1-preview-2024-09-12"])(
    "sends no sampling parameters to the o-series model %s",
    async (model) => {
      const params = await generateTextParams(model);
      expect(params).not.toHaveProperty("temperature");
      expect(params).not.toHaveProperty("top_p");
      // The rest of the request is unchanged, so an o-series call is the same
      // call with the two rejected fields removed rather than a different shape.
      expect(params).toMatchObject({
        model,
        max_completion_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
    },
  );

  it.each([
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-5.6-sol",
    "gpt-oss-20b",
    // A real id that starts with `o` and is not a reasoning model, which is
    // what keeps the family test from being a bare "starts with o".
    "omni-moderation-latest",
  ])("still pins the sampling parameters on %s", async (model) => {
    const params = await generateTextParams(model);
    expect(params).toMatchObject({ temperature: 1, top_p: 1 });
  });
});

describe("openaiStreamChat sampling parameters", () => {
  const streamParams = async (
    model: string,
  ): Promise<Record<string, unknown>> => {
    const create = vi.fn().mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        // No chunks: these cases are about the request that went out.
      },
    });

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        chat = { completions: { create } };
      },
    }));

    const { openaiStreamChat } = await import("../src/openai.utils");
    for await (const _event of openaiStreamChat({
      apiKey: "test-key",
      model,
      input: {
        messages: [{ role: "user", content: "hi" }],
        // Every optional parameter the caller can supply, so the assertions
        // are about the model and not about which fields were left undefined.
        temperature: 0.4,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        seed: 7,
        stopSequences: ["END"],
      },
    })) {
      // drain
    }

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0] as Record<string, unknown>;
    vi.doUnmock("openai");
    return params;
  };

  // This is the streaming half of a fix that already landed on the
  // non-streaming call above: the same reasoning ids come through this entry
  // point (Azure by deployment name, OpenRouter by routing prefix) and answer a
  // request carrying the sampling or penalty fields with a 400 before any
  // token is generated.
  it.each([
    "o1",
    "o1-mini",
    "o3-mini",
    "o4-mini",
    "openai/o3-mini",
    // The same o-series id behind a colon-qualified vendor prefix. This is the
    // shape the boundary test used to read as a plain sampled model, so it sent
    // `temperature` and took a 400 from the provider.
    "openai:o3-mini",
  ])(
    "sends no sampling or penalty parameter to the o-series model %s",
    async (model) => {
      const params = await streamParams(model);

      for (const field of [
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
      ]) {
        expect(params).not.toHaveProperty(field);
      }

      // The rest of the request is unchanged: an o-series stream is the same
      // call with the rejected fields removed rather than a different shape.
      expect(params).toMatchObject({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
        stop: ["END"],
        seed: 7,
      });
    },
  );

  it.each([
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-5.6-sol",
    "gpt-oss-20b",
    // A hyphen is the intra-id separator every published id uses, so a user-chosen
    // Azure deployment alias that happens to contain `o<digit>` is still a
    // sampled model. Widening the prefix boundary to include `-` would read this
    // as a reasoning model and drop the parameters without an error.
    "llama-o1-finetune",
  ])("still pins the sampling parameters on %s", async (model) => {
    const params = await streamParams(model);
    expect(params).toMatchObject({
      temperature: 0.4,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
    });
  });
});
