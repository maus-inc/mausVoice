import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendAudio: vi.fn(),
  finalize: vi.fn().mockResolvedValue("final transcript"),
  isComplete: vi.fn(() => true),
  cleanup: vi.fn(),
  getWarnings: vi.fn(() => [] as string[]),
  createSession: vi.fn(),
  sessionOptions: null as null | {
    onReady?: () => void;
    onConnectionInterrupted?: () => void;
    onFinalSegment?: (segment: string) => void;
  },
}));

vi.mock("@maus-inc/voice-ai", () => ({
  convertFloat32ToPCM16: (samples: Float32Array) =>
    new Int16Array(samples.length).buffer,
  createGladiaStreamingSession: (options: {
    onReady?: () => void;
    onConnectionInterrupted?: () => void;
    onFinalSegment?: (segment: string) => void;
  }) => {
    mocks.sessionOptions = options;
    return mocks.createSession();
  },
  normalizeGladiaModel: (model: string | null) =>
    model === "solaria-1" ? model : "solaria-1",
}));

vi.mock("../store", () => ({
  getAppState: () => ({}),
}));

vi.mock("../utils/user.utils", () => ({
  loadMyEffectiveDictationLanguage: vi.fn().mockResolvedValue("en-US"),
}));

vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: () => ({ sources: [], replacements: [] }),
}));

import { GladiaTranscriptionSession } from "./gladia-transcription-session";

beforeEach(() => {
  mocks.sessionOptions = null;
  mocks.sendAudio.mockClear();
  mocks.finalize.mockClear();
  mocks.isComplete.mockReset().mockReturnValue(true);
  mocks.cleanup.mockClear();
  mocks.getWarnings.mockClear();
  mocks.createSession.mockReset().mockReturnValue({
    sendAudio: mocks.sendAudio,
    finalize: mocks.finalize,
    isComplete: mocks.isComplete,
    cleanup: mocks.cleanup,
    getWarnings: mocks.getWarnings,
  });
});

describe("GladiaTranscriptionSession", () => {
  it("retires partial capture without finalizing the provider stream", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    const audio = { samples: [0.5], sampleRate: 16000, captureFailed: true };
    const finalization = session.finalize(audio);
    expect(session.finalize(audio)).toBe(finalization);
    const result = await finalization;
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toContain(
      "Audio capture stopped unexpectedly; recording may be incomplete",
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
  it("buffers audio until the validated live session is ready", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    const onSegment = vi.fn();
    session.setInterimResultCallback(onSegment);

    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array(320).fill(0.25));
    expect(mocks.sendAudio).not.toHaveBeenCalled();

    mocks.sessionOptions?.onReady?.();
    expect(mocks.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.sendAudio.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);

    mocks.sessionOptions?.onConnectionInterrupted?.();
    session.writeAudioChunk(new Float32Array(320).fill(0.25));
    expect(mocks.sendAudio).toHaveBeenCalledOnce();
    mocks.sessionOptions?.onReady?.();
    expect(mocks.sendAudio).toHaveBeenCalledTimes(2);

    mocks.sessionOptions?.onFinalSegment?.("committed");
    expect(onSegment).toHaveBeenCalledWith("committed");
  });

  it("returns the provider result and exposes a pause-safe 179-minute cap", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();

    expect(session.getMaximumRecordingDurationMs()).toBe(179 * 60 * 1000);
    const result = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    expect(result).toMatchObject({
      rawTranscript: "final transcript",
      metadata: {
        inferenceDevice: "API • Gladia (Streaming)",
        modelSize: "solaria-1",
        transcriptionMode: "api",
      },
      warnings: [],
    });
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("rejects a best-effort transcript when the provider did not complete", async () => {
    mocks.isComplete.mockReturnValue(false);
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    const result = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toContain(
      "Gladia did not complete the recording transcription.",
    );
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("records Gladia's normalized model for an unsupported persisted value", async () => {
    const session = new GladiaTranscriptionSession("key", "retired-model");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();

    const result = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });

    // createGladiaStreamingSession normalizes the actual wire request. History
    // must describe that effective model rather than the stale value.
    expect(result.metadata.modelSize).toBe("solaria-1");
  });

  it("hands locally buffered reconnect audio to the SDK before finalizing", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    mocks.sessionOptions?.onConnectionInterrupted?.();
    session.writeAudioChunk(new Float32Array(320).fill(0.25));
    expect(mocks.sendAudio).not.toHaveBeenCalled();

    await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });

    expect(mocks.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.finalize).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("rejects a partial result after startup audio overflows", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    const onSegment = vi.fn();
    session.setInterimResultCallback(onSegment);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array(31 * 16000));
    mocks.sessionOptions?.onFinalSegment?.("partial words");
    const result = await session.finalize({
      samples: new Float32Array(1),
      sampleRate: 16000,
    });
    expect(result).toMatchObject({
      rawTranscript: null,
      warnings: expect.arrayContaining([
        "Gladia did not receive the complete recording.",
      ]),
    });
    expect(onSegment).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("rejects a partial result if the final audio send fails", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    session.writeAudioChunk(new Float32Array(100).fill(0.25));
    mocks.sendAudio.mockImplementationOnce(() => {
      throw new Error("private provider payload");
    });
    const result = await session.finalize({
      samples: new Float32Array(100),
      sampleRate: 16000,
    });
    expect(result).toMatchObject({
      rawTranscript: null,
      warnings: expect.arrayContaining([
        "Gladia did not receive the complete recording.",
      ]),
    });
    expect(JSON.stringify(result.warnings)).not.toContain(
      "private provider payload",
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("can recover a transient non-final send failure without dropping audio", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    mocks.sendAudio.mockImplementationOnce(() => {
      throw new Error("temporary");
    });
    session.writeAudioChunk(new Float32Array(320).fill(0.25));
    session.writeAudioChunk(new Float32Array(320).fill(0.5));
    const result = await session.finalize({
      samples: new Float32Array(640),
      sampleRate: 16000,
    });
    expect(result.rawTranscript).toBe("final transcript");
    const successfulPayload = mocks.sendAudio.mock.calls[1]?.[0] as ArrayBuffer;
    expect(successfulPayload.byteLength).toBe(640 * 2);
    expect(mocks.finalize).toHaveBeenCalledOnce();
  });

  it("releases the SDK session when flushing final audio throws", async () => {
    const gladiaUtils = await import("../utils/gladia.utils");
    const spy = vi
      .spyOn(gladiaUtils, "createStreamingResampler")
      .mockReturnValueOnce({
        process: (chunk: Float32Array) => chunk,
        flush: () => {
          throw new Error("flush failed");
        },
        reset: vi.fn(),
      });
    try {
      const session = new GladiaTranscriptionSession("key", "solaria-1");
      await session.onRecordingStart(16000);
      mocks.sessionOptions?.onReady?.();
      await expect(
        session.finalize({ samples: new Float32Array(0), sampleRate: 16000 }),
      ).rejects.toThrow("flush failed");
      expect(mocks.cleanup).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("shares one provider finalization for concurrent callers", async () => {
    let finish: (value: string) => void = () => {
      throw new Error("not initialized");
    };
    mocks.finalize.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    const first = session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    const second = session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    await vi.waitFor(() => expect(mocks.finalize).toHaveBeenCalled());
    expect(mocks.finalize).toHaveBeenCalledOnce();
    finish("shared transcript");
    await expect(first).resolves.toMatchObject({
      rawTranscript: "shared transcript",
    });
    await expect(second).resolves.toMatchObject({
      rawTranscript: "shared transcript",
    });
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("does not finalize a session retired while waiting for readiness", async () => {
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    const pending = session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    await Promise.resolve();
    session.cleanup();
    const result = await pending;
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(result.rawTranscript).toBeNull();
    expect(result.warnings).toContain("Gladia finalization was cancelled.");
  });

  it("does not tear down a replacement session when an older finalization completes", async () => {
    let finish: (value: string) => void = () => {
      throw new Error("not initialized");
    };
    const oldFinalize = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    const create = (
      finalize: typeof oldFinalize,
      cleanup: typeof oldCleanup,
    ) => ({
      sendAudio: vi.fn(),
      finalize,
      cleanup,
      getWarnings: () => [],
    });
    mocks.createSession
      .mockReset()
      .mockReturnValueOnce(create(oldFinalize, oldCleanup))
      .mockReturnValueOnce(
        create(vi.fn().mockResolvedValue("new"), newCleanup),
      );
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    const pending = session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    await vi.waitFor(() => expect(oldFinalize).toHaveBeenCalledOnce());
    session.cleanup();
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    finish("old result");
    await pending;
    expect(oldCleanup).toHaveBeenCalledOnce();
    expect(newCleanup).not.toHaveBeenCalled();
    session.cleanup();
    expect(newCleanup).toHaveBeenCalledOnce();
  });

  it("does not attribute a retired startup failure to the replacement session", async () => {
    const { loadMyEffectiveDictationLanguage } =
      await import("../utils/user.utils");
    let rejectOld: (reason: Error) => void = () => {
      throw new Error("not initialized");
    };
    vi.mocked(loadMyEffectiveDictationLanguage).mockImplementationOnce(
      () =>
        new Promise<
          Awaited<ReturnType<typeof loadMyEffectiveDictationLanguage>>
        >((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    const oldStart = session.onRecordingStart(16000);
    await session.onRecordingStart(16000);
    mocks.sessionOptions?.onReady?.();
    rejectOld(new Error("old startup failed"));
    await oldStart;
    const result = await session.finalize({
      samples: new Float32Array(0),
      sampleRate: 16000,
    });
    expect(result.warnings).toEqual([]);
  });

  it("retires the previous SDK session before starting a replacement", async () => {
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    mocks.createSession
      .mockReset()
      .mockReturnValueOnce({
        sendAudio: vi.fn(),
        finalize: vi.fn(),
        cleanup: oldCleanup,
        getWarnings: () => [],
      })
      .mockReturnValueOnce({
        sendAudio: vi.fn(),
        finalize: vi.fn(),
        cleanup: newCleanup,
        getWarnings: () => [],
      });
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    const previousCallbacks = mocks.sessionOptions;
    await session.onRecordingStart(16000);
    expect(oldCleanup).toHaveBeenCalledOnce();
    expect(newCleanup).not.toHaveBeenCalled();
    previousCallbacks?.onReady?.();
    expect(newCleanup).not.toHaveBeenCalled();
    session.cleanup();
    expect(newCleanup).toHaveBeenCalledOnce();
  });

  it("retires resources even when the SDK cleanup throws", async () => {
    mocks.cleanup.mockImplementationOnce(() => {
      throw new Error("SDK close failed");
    });
    const session = new GladiaTranscriptionSession("key", "solaria-1");
    await session.onRecordingStart(16000);
    const retired = mocks.sessionOptions;
    expect(() => session.cleanup()).not.toThrow();
    retired?.onReady?.();
    session.writeAudioChunk(new Float32Array(320));
    expect(mocks.sendAudio).not.toHaveBeenCalled();
    session.cleanup();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("cleans buffers and the SDK session idempotently", async () => {
    const session = new GladiaTranscriptionSession("key", null);
    await session.onRecordingStart(16000);
    session.cleanup();
    session.cleanup();

    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
