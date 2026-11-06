import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Recognizer = {
  recognized?: (
    sender: unknown,
    event: { result: { reason: string; text: string } },
  ) => void;
  canceled?: (
    sender: unknown,
    event: { reason: string; errorDetails?: string },
  ) => void;
  sessionStopped?: () => void;
  startSuccess?: () => void;
  startError?: (error: string) => void;
  stopSuccess?: () => void;
  stopError?: (error: string) => void;
  close: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};
const fixtures = vi.hoisted(() => ({
  recognizers: [] as Recognizer[],
  streams: [] as {
    write: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("microsoft-cognitiveservices-speech-sdk", () => ({
  SpeechConfig: { fromSubscription: () => ({ speechRecognitionLanguage: "" }) },
  AudioStreamFormat: { getWaveFormatPCM: () => ({}) },
  AudioInputStream: {
    createPushStream: () => {
      const stream = { write: vi.fn(), close: vi.fn() };
      fixtures.streams.push(stream);
      return stream;
    },
  },
  AudioConfig: { fromStreamInput: () => ({}) },
  PhraseListGrammar: { fromRecognizer: () => ({ addPhrase: vi.fn() }) },
  SpeechRecognizer: class {
    recognized?: Recognizer["recognized"];
    canceled?: Recognizer["canceled"];
    sessionStopped?: Recognizer["sessionStopped"];
    startSuccess?: () => void;
    startError?: (error: string) => void;
    stopSuccess?: () => void;
    stopError?: (error: string) => void;
    close = vi.fn();
    stop = vi.fn();
    constructor() {
      fixtures.recognizers.push(this);
    }
    startContinuousRecognitionAsync(
      success: () => void,
      error: (error: string) => void,
    ) {
      this.startSuccess = success;
      this.startError = error;
    }
    stopContinuousRecognitionAsync(
      success: () => void,
      error: (error: string) => void,
    ) {
      this.stopSuccess = success;
      this.stopError = error;
      this.stop();
    }
  },
  ResultReason: { RecognizedSpeech: "recognized" },
  CancellationReason: { EndOfStream: "end", Error: "error" },
}));

import { createAzureStreamingSession } from "./azure.utils";

const start = (signal?: AbortSignal) =>
  createAzureStreamingSession({
    subscriptionKey: "key",
    region: "eastus",
    sampleRate: 16000,
    signal,
  });
const getRecognizer = () => {
  const recognizer = fixtures.recognizers[fixtures.recognizers.length - 1];
  if (!recognizer) throw new Error("missing recognizer");
  return recognizer;
};
const text = (recognizer: Recognizer, value: string) =>
  recognizer.recognized?.(null, {
    result: { reason: "recognized", text: value },
  });

beforeEach(() => {
  fixtures.recognizers.length = 0;
  fixtures.streams.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Azure streaming lifecycle", () => {
  it("drains audio and final results before stopping and resolving", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    session.writeAudioChunk(new Float32Array([0.5, -1, 1]));
    expect(fixtures.streams[0].write).toHaveBeenCalledOnce();
    const written = fixtures.streams[0].write.mock.calls[0][0] as ArrayBuffer;
    expect(Array.from(new Uint8Array(written))).toEqual([
      255, 63, 0, 128, 255, 127,
    ]);
    text(recognizer, "first");
    const result = session.finalize();
    expect(session.finalize()).toBe(result);
    expect(fixtures.streams[0].close).toHaveBeenCalledOnce();
    expect(recognizer.stop).not.toHaveBeenCalled();
    text(recognizer, "tail");
    recognizer.canceled?.(null, { reason: "end" });
    recognizer.sessionStopped?.();
    expect(recognizer.stop).toHaveBeenCalledOnce();
    recognizer.stopSuccess?.();
    await expect(result).resolves.toBe("first tail");
    expect(recognizer.close).toHaveBeenCalledOnce();
    text(recognizer, "late");
    await expect(session.finalize()).resolves.toBe("first tail");
  });

  it("rejects partial text after a provider cancellation without logging its details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    text(recognizer, "partial");
    recognizer.canceled?.(null, {
      reason: "error",
      errorDetails: "private token and transcript",
    });
    await expect(session.finalize()).rejects.toThrow("interrupted");
    expect(recognizer.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private token");
  });

  it("rejects when the service stops before input is closed", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    recognizer.sessionStopped?.();
    await expect(session.finalize()).rejects.toThrow("stopped unexpectedly");
    expect(recognizer.stop).not.toHaveBeenCalled();
  });

  it("fails instead of returning partial text when stop fails", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    text(recognizer, "partial");
    const result = session.finalize();
    recognizer.sessionStopped?.();
    recognizer.stopError?.("private provider detail");
    await expect(result).rejects.toThrow("could not stop");
    expect(recognizer.close).toHaveBeenCalledOnce();
  });

  it("bounds the drain and never returns partial text on timeout", async () => {
    vi.useFakeTimers();
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    text(recognizer, "partial");
    const result = session.finalize();
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    recognizer.sessionStopped?.();
    expect(recognizer.stop).not.toHaveBeenCalled();
    expect(recognizer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung startup and ignores a late successful callback", async () => {
    vi.useFakeTimers();
    const pending = start();
    const recognizer = getRecognizer();
    const assertion = expect(pending).rejects.toThrow("startup timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    recognizer.startSuccess?.();
    expect(recognizer.close).toHaveBeenCalledOnce();
    expect(fixtures.streams[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate SDK resources for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(null);
    await expect(start(controller.signal)).rejects.toBeNull();
    expect(fixtures.recognizers).toHaveLength(0);
    expect(fixtures.streams).toHaveLength(0);
  });

  it("handles a synchronous end and stop acknowledgement during input close", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    text(recognizer, "complete");
    recognizer.stop.mockImplementation(() => recognizer.stopSuccess?.());
    fixtures.streams[0].close.mockImplementation(() => {
      recognizer.sessionStopped?.();
    });
    await expect(session.finalize()).resolves.toBe("complete");
    expect(recognizer.close).toHaveBeenCalledOnce();
  });

  it("aborts pending startup with the exact reason and closes resources", async () => {
    const controller = new AbortController();
    const pending = start(controller.signal);
    const recognizer = getRecognizer();
    controller.abort(null);
    await expect(pending).rejects.toBeNull();
    recognizer.startSuccess?.();
    expect(recognizer.close).toHaveBeenCalledOnce();
    expect(fixtures.streams[0].close).toHaveBeenCalledOnce();
  });

  it("retries input cleanup and rejects if closing the stream fails", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    fixtures.streams[0].close.mockImplementationOnce(() => {
      throw new Error("private close failure");
    });
    await expect(session.finalize()).rejects.toThrow(
      "audio could not be finalized",
    );
    expect(fixtures.streams[0].close).toHaveBeenCalledTimes(2);
    expect(recognizer.close).toHaveBeenCalledOnce();
  });

  it("fails and closes when the audio stream cannot accept a chunk", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    fixtures.streams[0].write.mockImplementation(() => {
      throw new Error("private SDK payload");
    });
    expect(() => session.writeAudioChunk(new Float32Array([0.5]))).toThrow(
      "audio could not be sent",
    );
    await expect(session.finalize()).rejects.toThrow("audio could not be sent");
    expect(recognizer.close).toHaveBeenCalledOnce();
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects invalid input before writing it to Azure (%s)",
    async (sample) => {
      const pending = start();
      const recognizer = getRecognizer();
      recognizer.startSuccess?.();
      const session = await pending;
      expect(() =>
        session.writeAudioChunk(new Float32Array([0.5, sample])),
      ).toThrow("audio could not be sent");
      await expect(session.finalize()).rejects.toThrow(
        "audio could not be sent",
      );
      expect(fixtures.streams[0].write).not.toHaveBeenCalled();
      expect(recognizer.close).toHaveBeenCalledOnce();
    },
  );

  it("bounds a stalled stop acknowledgement after the service ends", async () => {
    vi.useFakeTimers();
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    const result = session.finalize();
    const assertion = expect(result).rejects.toThrow("timed out");
    recognizer.sessionStopped?.();
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    recognizer.stopSuccess?.();
    expect(recognizer.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a pending finalizer when the session is discarded", async () => {
    const pending = start();
    const recognizer = getRecognizer();
    recognizer.startSuccess?.();
    const session = await pending;
    const result = session.finalize();
    session.cleanup();
    await expect(result).rejects.toThrow("cancelled");
    recognizer.sessionStopped?.();
    expect(recognizer.stop).not.toHaveBeenCalled();
    expect(recognizer.close).toHaveBeenCalledOnce();
  });
});
