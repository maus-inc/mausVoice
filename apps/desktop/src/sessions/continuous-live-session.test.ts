import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InterimResultCallback,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { ContinuousLiveSession } from "./continuous-live-session";

const audio = (length: number) => ({
  samples: Float32Array.from({ length }, (_, index) => index + 1),
  sampleRate: 16000,
});
const success: TranscriptionSessionResult = {
  rawTranscript: "complete",
  metadata: { transcriptionMode: "api" },
  warnings: [],
};

function sourceSession() {
  let interim: InterimResultCallback | undefined;
  const source: TranscriptionSession = {
    onBeforeRecordingStart: vi.fn().mockResolvedValue(undefined),
    onRecordingStart: vi.fn().mockResolvedValue(undefined),
    writeAudioChunk: vi.fn(),
    finalize: vi.fn().mockResolvedValue(success),
    cleanup: vi.fn(),
    supportsStreaming: () => true,
    setInterimResultCallback: (callback) => {
      interim = callback;
    },
    getMaximumRecordingDurationMs: () => 900,
  };
  return { source, interim: (text: string) => interim?.(text) };
}

afterEach(() => vi.useRealTimers());

describe("live audio continuity", () => {
  it("forwards contiguous samples and finalizes exactly once", async () => {
    const { source } = sourceSession();
    const session = new ContinuousLiveSession(source);
    const getGeneration = () => 42;
    await session.onBeforeRecordingStart("owner", getGeneration);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1, 2]), 0);
    session.writeAudioChunk(new Float32Array([3]), 2);
    const recording = audio(3);
    const first = session.finalize(recording);
    expect(session.finalize(recording)).toBe(first);
    await expect(first).resolves.toEqual(success);
    expect(source.onBeforeRecordingStart).toHaveBeenCalledWith(
      "owner",
      getGeneration,
    );
    expect(source.writeAudioChunk).toHaveBeenCalledTimes(2);
    expect(source.finalize).toHaveBeenCalledExactlyOnceWith(recording);
    expect(session.getMaximumRecordingDurationMs?.()).toBe(900);
  });

  it.each([1, -1, NaN, Infinity])(
    "rejects a first chunk with invalid offset %s",
    async (offset) => {
      const { source } = sourceSession();
      const session = new ContinuousLiveSession(source);
      await session.onRecordingStart(16000);
      session.writeAudioChunk(new Float32Array([1]), offset);
      await expect(session.finalize(audio(1))).resolves.toMatchObject({
        rawTranscript: null,
        warnings: [expect.stringContaining("complete recording")],
      });
      expect(source.cleanup).toHaveBeenCalledOnce();
      expect(source.writeAudioChunk).not.toHaveBeenCalled();
      expect(source.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "retires a stream before forwarding non-finite audio %s",
    async (sample) => {
      const { source } = sourceSession();
      const session = new ContinuousLiveSession(source);
      await session.onRecordingStart(16000);
      session.writeAudioChunk(new Float32Array([0.5, sample]), 0);
      await expect(session.finalize(audio(2))).resolves.toMatchObject({
        rawTranscript: null,
        warnings: [expect.stringContaining("complete recording")],
      });
      expect(source.writeAudioChunk).not.toHaveBeenCalled();
      expect(source.cleanup).toHaveBeenCalledOnce();
      expect(source.finalize).not.toHaveBeenCalled();
    },
  );

  it("retires a stream at the first gap and suppresses later interim output", async () => {
    const { source, interim } = sourceSession();
    const session = new ContinuousLiveSession(source);
    const callback = vi.fn();
    session.setInterimResultCallback(callback);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    interim("before gap");
    session.writeAudioChunk(new Float32Array([3]), 2);
    interim("after gap");
    session.writeAudioChunk(new Float32Array([4]), 3);
    expect(callback.mock.calls).toEqual([["before gap"]]);
    expect(source.writeAudioChunk).toHaveBeenCalledOnce();
    expect(source.cleanup).toHaveBeenCalledOnce();
    await expect(session.finalize(audio(4))).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(source.finalize).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, NaN, Infinity, 48000])(
    "rejects final audio with invalid or changed sample rate %s",
    async (sampleRate) => {
      const { source } = sourceSession();
      const session = new ContinuousLiveSession(source);
      await session.onRecordingStart(16000);
      session.writeAudioChunk(new Float32Array([1]), 0);
      await expect(
        session.finalize({ samples: [1], sampleRate }),
      ).resolves.toMatchObject({
        rawTranscript: null,
        warnings: [expect.any(String)],
      });
      expect(source.finalize).not.toHaveBeenCalled();
    },
  );

  it("rejects equal-length live audio that differs from the saved recording", async () => {
    const { source } = sourceSession();
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1, 99, 3]), 0);
    await expect(session.finalize(audio(3))).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.stringContaining("complete recording")],
    });
    expect(source.cleanup).toHaveBeenCalledOnce();
    expect(source.finalize).not.toHaveBeenCalled();
  });

  it("does not finalize a capture marked incomplete even if its prefix matches", async () => {
    const { source } = sourceSession();
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    await expect(
      session.finalize({ ...audio(1), captureFailed: true }),
    ).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(source.finalize).not.toHaveBeenCalled();
    expect(source.cleanup).toHaveBeenCalledOnce();
  });

  it("waits for a delayed tail event rather than misclassifying it as loss", async () => {
    vi.useFakeTimers();
    const { source } = sourceSession();
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    const pending = session.finalize(audio(2));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(source.finalize).not.toHaveBeenCalled();
    session.writeAudioChunk(new Float32Array([2]), 1);
    await expect(pending).resolves.toEqual(success);
    expect(source.finalize).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the recording instead of accepting a missing tail or listener", async () => {
    vi.useFakeTimers();
    const { source } = sourceSession();
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    const pending = session.finalize(audio(4));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(source.cleanup).toHaveBeenCalledOnce();
    expect(source.finalize).not.toHaveBeenCalled();
  });

  it("allows slow startup to finish and then receives the buffered chunks", async () => {
    vi.useFakeTimers();
    const { source } = sourceSession();
    let finishStartup: () => void = () => {
      throw new Error("startup not called");
    };
    vi.mocked(source.onRecordingStart).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStartup = resolve;
        }),
    );
    const session = new ContinuousLiveSession(source);
    const startup = session.onRecordingStart(16000);
    const pending = session.finalize(audio(2));
    await vi.advanceTimersByTimeAsync(5_000);
    finishStartup();
    await startup;
    session.writeAudioChunk(new Float32Array([1, 2]), 0);
    await expect(pending).resolves.toEqual(success);
  });

  it("cancels pending finalization without reporting a recovery failure", async () => {
    vi.useFakeTimers();
    const { source } = sourceSession();
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    const pending = session.finalize(audio(3));
    session.cleanup();
    await expect(pending).resolves.toEqual({
      rawTranscript: null,
      metadata: {},
      warnings: [],
    });
    expect(source.cleanup).toHaveBeenCalledOnce();
    expect(source.finalize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves audio when a provider finalizer unexpectedly rejects", async () => {
    const { source } = sourceSession();
    vi.mocked(source.finalize).mockRejectedValue(
      new Error("private provider payload"),
    );
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    await expect(session.finalize(audio(1))).resolves.toMatchObject({
      rawTranscript: null,
      warnings: ["Live transcription could not be finalized"],
    });
    expect(source.cleanup).toHaveBeenCalledOnce();
  });

  it("settles cancellation even if the provider finalizer never responds", async () => {
    const { source } = sourceSession();
    vi.mocked(source.finalize).mockReturnValue(new Promise(() => {}));
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    const pending = session.finalize(audio(1));
    await Promise.resolve();
    session.cleanup();
    await expect(pending).resolves.toEqual({
      rawTranscript: null,
      metadata: {},
      warnings: [],
    });
    expect(source.cleanup).toHaveBeenCalledOnce();
  });

  it("observes a provider rejection that arrives after cancellation", async () => {
    const { source } = sourceSession();
    let rejectProvider: (error: Error) => void = () => {
      throw new Error("provider not started");
    };
    vi.mocked(source.finalize).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectProvider = reject;
        }),
    );
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    const pending = session.finalize(audio(1));
    await Promise.resolve();
    session.cleanup();
    await expect(pending).resolves.toEqual({
      rawTranscript: null,
      metadata: {},
      warnings: [],
    });
    rejectProvider(new Error("late provider failure"));
    await Promise.resolve();
  });

  it("discards a provider result that arrives after cancellation", async () => {
    const { source } = sourceSession();
    let resolveProvider: (value: TranscriptionSessionResult) => void = () => {
      throw new Error("provider not started");
    };
    vi.mocked(source.finalize).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    const pending = session.finalize(audio(1));
    await Promise.resolve();
    session.cleanup();
    resolveProvider(success);
    await expect(pending).resolves.toEqual({
      rawTranscript: null,
      metadata: {},
      warnings: [],
    });
  });

  it("rejects a stream whose provider sink throws", async () => {
    const { source } = sourceSession();
    vi.mocked(source.writeAudioChunk!).mockImplementation(() => {
      throw new Error("write failed");
    });
    const session = new ContinuousLiveSession(source);
    await session.onRecordingStart(16000);
    session.writeAudioChunk(new Float32Array([1]), 0);
    await expect(session.finalize(audio(1))).resolves.toMatchObject({
      rawTranscript: null,
      warnings: [expect.any(String)],
    });
    expect(source.cleanup).toHaveBeenCalledOnce();
    expect(source.finalize).not.toHaveBeenCalled();
  });
});
