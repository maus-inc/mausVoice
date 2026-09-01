import { afterEach, describe, expect, it, vi } from "vitest";

const importWithSdkMock = async ({
  upload = { audio_url: "https://api.gladia.io/audio/test" },
  create = { id: "job-1" },
  poll = {
    result: {
      transcription: {
        full_transcript: "Hello Gladia",
        utterances: [],
      },
    },
  },
  deleteResult = true,
}: {
  upload?: unknown;
  create?: unknown;
  poll?: unknown;
  deleteResult?: boolean | Error;
} = {}) => {
  const uploadFile = vi.fn().mockResolvedValue(upload);
  const createUntyped = vi.fn().mockResolvedValue(create);
  const pollJob = vi.fn().mockResolvedValue(poll);
  const deleteJob =
    deleteResult instanceof Error
      ? vi.fn().mockRejectedValue(deleteResult)
      : vi.fn().mockResolvedValue(deleteResult);
  const preRecordedV2 = vi.fn(() => ({
    uploadFile,
    createUntyped,
    poll: pollJob,
    delete: deleteJob,
  }));
  const clientOptions: unknown[] = [];

  vi.resetModules();
  vi.doMock("@gladiaio/sdk", () => ({
    GladiaClient: class MockGladiaClient {
      constructor(options: unknown) {
        clientOptions.push(options);
      }
      preRecordedV2 = preRecordedV2;
    },
  }));

  const module = await import("./gladia.utils");
  return {
    ...module,
    mocks: {
      uploadFile,
      createUntyped,
      pollJob,
      deleteJob,
      clientOptions,
    },
  };
};

afterEach(() => {
  vi.doUnmock("@gladiaio/sdk");
  vi.restoreAllMocks();
});

describe("gladiaTranscribeAudio", () => {
  it("rejects a blank key before constructing an SDK client", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock();

    await expect(
      gladiaTranscribeAudio({
        apiKey: "  ",
        blob: new ArrayBuffer(4),
        language: "auto",
      }),
    ).rejects.toThrow("API key is required");
    expect(mocks.clientOptions).toEqual([]);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("uploads, creates, polls, maps customization, and deletes", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock();

    const output = await gladiaTranscribeAudio({
      apiKey: " key ",
      blob: new ArrayBuffer(16),
      language: "en-US",
      model: "solaria-1",
      pollIntervalMs: 0,
      customizations: {
        vocabulary: ["MausVoice"],
        spellingDictionary: { "Maus Voice": ["mouse voice"] },
      },
    });

    expect(output).toEqual({ text: "Hello Gladia", warnings: [] });
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.createUntyped).toHaveBeenCalledWith({
      audio_url: "https://api.gladia.io/audio/test",
      model: "solaria-1",
      language_config: { languages: ["en"], code_switching: false },
      custom_vocabulary: true,
      custom_vocabulary_config: {
        vocabulary: ["MausVoice"],
        default_intensity: 0.4,
      },
      custom_spelling: true,
      custom_spelling_config: {
        spelling_dictionary: { "Maus Voice": ["mouse voice"] },
      },
    });
    expect(mocks.pollJob).toHaveBeenCalledWith("job-1", {
      interval: 0,
      timeout: 7_200_000,
    });
    expect(mocks.deleteJob).toHaveBeenCalledWith("job-1");
    expect(mocks.clientOptions[0]).toMatchObject({
      apiKey: "key",
      httpRetry: { maxAttempts: 3 },
    });
  });

  it("normalizes non-finite polling controls to bounded defaults", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock();

    await gladiaTranscribeAudio({
      apiKey: "key",
      blob: new ArrayBuffer(4),
      language: "auto",
      pollIntervalMs: Number.NaN,
      timeoutMs: Number.POSITIVE_INFINITY,
    });

    expect(mocks.pollJob).toHaveBeenCalledWith("job-1", {
      interval: 3_000,
      timeout: 7_200_000,
    });
    expect(mocks.clientOptions[0]).toMatchObject({
      prerecordedTimeouts: { poll: 7_200_000 },
    });
  });

  it("caps excessive finite polling controls", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock();

    await gladiaTranscribeAudio({
      apiKey: "key",
      blob: new ArrayBuffer(4),
      language: "auto",
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(mocks.pollJob).toHaveBeenCalledWith("job-1", {
      interval: 60_000,
      timeout: 7_200_000,
    });
  });

  it("keeps a successful transcript and returns a visible deletion warning", async () => {
    const { gladiaTranscribeAudio } = await importWithSdkMock({
      deleteResult: new Error("retention service unavailable"),
    });

    const output = await gladiaTranscribeAudio({
      apiKey: "key",
      blob: new ArrayBuffer(4),
      language: "auto",
      model: "old-model",
    });

    expect(output.text).toBe("Hello Gladia");
    expect(output.warnings).toEqual([
      "Unsupported Gladia model “old-model” was replaced with solaria-1.",
      "Gladia pre-recorded data deletion failed: retention service unavailable",
    ]);
  });

  it("deletes the remote job when polling fails without masking the failure", async () => {
    const pollError = new Error("poll failed");
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock();
    mocks.pollJob.mockRejectedValueOnce(pollError);

    await expect(
      gladiaTranscribeAudio({
        apiKey: "key",
        blob: new ArrayBuffer(4),
        language: "auto",
      }),
    ).rejects.toBe(pollError);
    expect(mocks.deleteJob).toHaveBeenCalledWith("job-1");
  });

  it("rejects malformed polling transcripts and still deletes the job", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock({
      poll: {
        result: {
          transcription: {
            full_transcript: 42,
            utterances: [],
          },
        },
      },
    });

    await expect(
      gladiaTranscribeAudio({
        apiKey: "key",
        blob: new ArrayBuffer(4),
        language: "auto",
      }),
    ).rejects.toThrow("malformed full transcript");
    expect(mocks.deleteJob).toHaveBeenCalledWith("job-1");
  });

  it("rejects malformed utterances even with a valid full transcript", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock({
      poll: {
        result: {
          transcription: {
            full_transcript: "Hello Gladia",
            utterances: [{ text: 42 }],
          },
        },
      },
    });

    await expect(
      gladiaTranscribeAudio({
        apiKey: "key",
        blob: new ArrayBuffer(4),
        language: "auto",
      }),
    ).rejects.toThrow("malformed transcript utterance");
    expect(mocks.deleteJob).toHaveBeenCalledWith("job-1");
  });

  it("rejects malformed create responses before polling", async () => {
    const { gladiaTranscribeAudio, mocks } = await importWithSdkMock({
      create: {},
    });

    await expect(
      gladiaTranscribeAudio({
        apiKey: "key",
        blob: new ArrayBuffer(4),
        language: "auto",
      }),
    ).rejects.toThrow("invalid transcription ID");
    expect(mocks.pollJob).not.toHaveBeenCalled();
    expect(mocks.deleteJob).not.toHaveBeenCalled();
  });
});
