import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StopRecordingResponse } from "../../types/transcription-session.types";
import {
  beginNativeRecording,
  resetNativeRecordingSession,
} from "../../utils/native-recording-session";
import {
  VoiceInstructionRecorder,
  type SpeechRecognitionLike,
  type VoiceInstructionRecorderDeps,
} from "./voiceInstructionRecorder";

class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  interimResults = false;
  maxAlternatives = 1;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null = null;
  onerror: (() => void) | null = null;
  onend: (() => void) | null = null;
  started = false;

  start(): void {
    this.started = true;
  }

  stop(): void {
    this.started = false;
    this.onend?.();
  }

  emitResult(transcript: string): void {
    this.onresult?.({ results: [[{ transcript }]] });
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Answers the native recording handshake the way the Rust side does. */
const nativeInvoke = (
  overrides: Record<
    string,
    (args?: Record<string, unknown>) => Promise<unknown>
  > = {},
) => {
  let generation = 0;
  return vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (overrides[cmd]) return overrides[cmd](args);
    switch (cmd) {
      case "recording_generation":
        generation += 1;
        return Promise.resolve(generation);
      case "start_recording":
        return Promise.resolve({ sampleRate: 16000 });
      case "stop_recording":
        return Promise.resolve({ samples: [0, 1], sampleRate: 16000 });
      default:
        return Promise.resolve(undefined);
    }
  });
};

beforeEach(() => {
  resetNativeRecordingSession();
});

const baseDeps = (
  overrides: Partial<VoiceInstructionRecorderDeps> = {},
): VoiceInstructionRecorderDeps => {
  const fake = new FakeRecognition();
  return {
    invoke: nativeInvoke(),
    transcribe: vi.fn().mockResolvedValue("transcript"),
    getPreferredMicrophone: () => null,
    createSpeechRecognition: () => fake,
    getLang: () => "en-US",
    canUseProvider: () => true,
    speechRecognitionSupported: true,
    unsupportedMessage: () => "unsupported",
    recordingUnavailableMessage: () => "recording unavailable",
    onListeningChange: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onResetLevels: vi.fn(),
    logger: { warning: vi.fn() },
    ...overrides,
    // Keep a single fake so tests can inspect the active recognizer.
    ...(overrides.createSpeechRecognition
      ? {}
      : { createSpeechRecognition: () => fake }),
  };
};

describe("VoiceInstructionRecorder", () => {
  it("starts provider recording, transcribes on stop, and returns to idle", async () => {
    const deps = baseDeps();
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("provider");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(true);
    expect(deps.invoke).toHaveBeenCalledWith("start_recording", {
      ownerId: expect.any(String),
      generation: 1,
      args: { preferredMicrophone: null },
    });

    await recorder.toggle();
    expect(deps.transcribe).toHaveBeenCalled();
    expect(deps.onTranscript).toHaveBeenCalledWith("transcript");
    expect(deps.onResetLevels).toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("falls back to browser recognition when provider recording fails", async () => {
    const deps = baseDeps({
      invoke: nativeInvoke({
        start_recording: () => Promise.reject(new Error("no mic")),
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("browser");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(true);

    // Toggling off stops the browser recognizer and returns to idle.
    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("does not open a browser capture when the native stop fails", async () => {
    const startedRecording = deferred<unknown>();
    const createSpeechRecognition = vi.fn(() => null);
    const deps = baseDeps({
      createSpeechRecognition,
      invoke: nativeInvoke({
        start_recording: () => startedRecording.promise,
        stop_recording: () => Promise.reject(new Error("stop failed")),
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const startPromise = recorder.toggle();
    startedRecording.resolve({ sampleRate: 16000 });
    await startPromise;
    // Give the start() continuation a tick to settle.
    await Promise.resolve();
    expect(recorder.getState()).toBe("provider");

    await recorder.toggle();
    // The failed stop leaves native holding the recorder, so starting the
    // browser recognizer here would open a second capture beside it. The
    // recorder stays idle and reports why instead.
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
    expect(deps.onResetLevels).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
    expect(createSpeechRecognition).not.toHaveBeenCalled();
  });

  it("claims the native slot for browser recognition and releases it on stop", async () => {
    const fake = new FakeRecognition();
    fake.stop = vi.fn();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("browser");
    expect(deps.invoke).toHaveBeenCalledWith("recording_generation", {
      ownerId: expect.any(String),
    });
    expect(deps.invoke).toHaveBeenCalledWith("claim_browser_recording", {
      ownerId: expect.any(String),
      generation: 1,
    });

    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.invoke).toHaveBeenCalledWith("release_browser_recording", {
      ownerId: expect.any(String),
      generation: 1,
    });
  });

  it("refuses browser recognition while a dictation holds the recorder", async () => {
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: vi.fn(() => null),
    });
    const recorder = new VoiceInstructionRecorder(deps);
    // A live native recording in this webview takes the same slot.
    await beginNativeRecording(null, {}, deps.invoke);

    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
    expect(deps.createSpeechRecognition).not.toHaveBeenCalled();
  });

  it("reports when the browser claim is refused by native", async () => {
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: vi.fn(() => null),
      invoke: nativeInvoke({
        claim_browser_recording: () =>
          Promise.reject(new Error("A recording is already in progress")),
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
  });

  it("rejects rapid duplicate starts (only one start_recording)", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: nativeInvoke({ start_recording: () => startDeferred.promise }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const first = recorder.toggle();
    const second = recorder.toggle();
    await vi.waitFor(() =>
      expect(
        (deps.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([command]) => command === "start_recording",
        ),
      ).toHaveLength(1),
    );

    startDeferred.resolve({ sampleRate: 16000 });
    await Promise.all([first, second]);
    expect(recorder.getState()).toBe("provider");
  });

  it("disposes provider recording on unmount and resets levels", () => {
    const deps = baseDeps();
    const recorder = new VoiceInstructionRecorder(deps);

    return recorder.toggle().then(() => {
      expect(recorder.getState()).toBe("provider");
      recorder.dispose();
      expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: 1,
      });
      expect(recorder.getState()).toBe("idle");
      expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("disposes browser recognition on unmount", async () => {
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: () => fake,
      invoke: nativeInvoke({
        start_recording: () => Promise.reject(new Error("no mic")),
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("browser");
    expect(fake.started).toBe(true);

    recorder.dispose();
    expect(fake.started).toBe(false);
    expect(recorder.getState()).toBe("idle");
  });

  it("reports an error and stays idle when no capture path is available", async () => {
    const deps = baseDeps({
      canUseProvider: () => false,
      speechRecognitionSupported: false,
      createSpeechRecognition: () => null,
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(deps.onError).toHaveBeenCalledWith("unsupported");
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).not.toHaveBeenCalled();
  });

  it("applies the spoken transcript via onTranscript during browser recognition", async () => {
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: () => fake,
      invoke: nativeInvoke({
        start_recording: () => Promise.reject(new Error("no mic")),
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    fake.emitResult("make this shorter");
    expect(deps.onTranscript).toHaveBeenCalledWith("make this shorter");
  });

  it("serializes a second toggle while stopping and issues a single stop_recording", async () => {
    const stopDeferred = deferred<StopRecordingResponse>();
    const deps = baseDeps({
      invoke: nativeInvoke({ stop_recording: () => stopDeferred.promise }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    const first = recorder.toggle();
    const second = recorder.toggle();
    stopDeferred.resolve({ samples: [0, 1], sampleRate: 16000 });
    await Promise.all([first, second]);

    const stops = (deps.invoke as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === "stop_recording",
    );
    expect(stops).toHaveLength(1);
    expect(recorder.getState()).toBe("idle");
  });

  it("does not fire callbacks after dispose during pending transcription", async () => {
    const stopDeferred = deferred<StopRecordingResponse>();
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording") return Promise.resolve();
        if (cmd === "stop_recording") return stopDeferred.promise;
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    const stopPromise = recorder.toggle();
    recorder.dispose();
    stopDeferred.resolve({ samples: [0, 1], sampleRate: 16000 });
    await stopPromise;

    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onResetLevels).not.toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
  });

  it("does not fire onTranscript/onError after dispose while transcribe is pending", async () => {
    const stopDeferred = deferred<StopRecordingResponse>();
    const transcribeDeferred = deferred<string>();
    const deps = baseDeps({
      invoke: nativeInvoke({ stop_recording: () => stopDeferred.promise }),
      transcribe: vi.fn().mockReturnValue(transcribeDeferred.promise),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    const stopPromise = recorder.toggle();
    recorder.dispose();
    // Stop resolves, transcribe is still in flight and resolves after dispose.
    stopDeferred.resolve({ samples: [0, 1], sampleRate: 16000 });
    transcribeDeferred.resolve("late transcript");
    await stopPromise;
    // Let any stray continuation settle.
    await Promise.resolve();

    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onResetLevels).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("does not fall back to browser recognition after dispose when transcribe rejects", async () => {
    const stopDeferred = deferred<StopRecordingResponse>();
    const transcribeDeferred = deferred<string>();
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: () => fake,
      invoke: nativeInvoke({ stop_recording: () => stopDeferred.promise }),
      transcribe: vi.fn().mockReturnValue(transcribeDeferred.promise),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    const stopPromise = recorder.toggle();
    // Resolve stop_recording but do NOT dispose yet, so the recorder proceeds to
    // invoke transcribe() and attach its await handler.
    stopDeferred.resolve({ samples: [0, 1], sampleRate: 16000 });
    // Wait until transcribe() is invoked (so its rejection is consumed by the
    // recorder's await) before we dispose and reject. Disposing earlier would
    // bail before transcribe, leaving the rejection unhandled.
    await vi.waitFor(() => expect(deps.transcribe).toHaveBeenCalled());
    recorder.dispose();
    transcribeDeferred.reject(new Error("transcribe failed"));
    await stopPromise;
    // Let the rejection continuation settle.
    await Promise.resolve();

    expect(fake.started).toBe(false);
    expect(deps.onError).not.toHaveBeenCalled();
    expect(deps.logger.warning).not.toHaveBeenCalled();
  });

  it("issues stop_recording when disposed while start_recording is pending", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: nativeInvoke({ start_recording: () => startDeferred.promise }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const togglePromise = recorder.toggle();
    // Dispose before the mic-open await resolves.
    recorder.dispose();
    expect(recorder.getState()).toBe("idle");

    startDeferred.resolve({ sampleRate: 16000 });
    await togglePromise;

    // The recorder must release the native mic instead of leaving it open.
    expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: expect.any(String),
      generation: 1,
    });
    expect(recorder.getState()).toBe("idle");
    // No UI notification that listening started, no transcript delivered.
    expect(deps.onListeningChange).not.toHaveBeenCalled();
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("does not start after dispose even when start_recording resolves", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: nativeInvoke({ start_recording: () => startDeferred.promise }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const togglePromise = recorder.toggle();
    recorder.dispose();
    startDeferred.resolve({ sampleRate: 16000 });
    await togglePromise;

    expect(recorder.getState()).toBe("idle");
    // A later toggle is a no-op because the recorder is disposed.
    await recorder.toggle();
    // The handshake (generation + start) and its cleanup discard only.
    expect(
      (deps.invoke as ReturnType<typeof vi.fn>).mock.calls.map(
        ([command]) => command,
      ),
    ).toEqual(["recording_generation", "start_recording", "discard_recording"]);
    expect(recorder.getState()).toBe("idle");
  });
  it.each(["missing", "constructor", "configuration"])(
    "contains %s browser setup failures and permits a retry",
    async (failure) => {
      const fake = new FakeRecognition();
      const deps = baseDeps({ canUseProvider: () => false });
      if (failure === "missing") deps.createSpeechRecognition = () => null;
      if (failure === "constructor") {
        deps.createSpeechRecognition = () => {
          throw new Error("private setup detail");
        };
      }
      if (failure === "configuration") {
        deps.getLang = () => {
          throw new Error("private setup detail");
        };
      }
      const recorder = new VoiceInstructionRecorder(deps);
      await expect(recorder.toggle()).resolves.toBeUndefined();
      expect(recorder.getState()).toBe("idle");
      expect(deps.onError).toHaveBeenCalledWith("unsupported");
      expect(
        JSON.stringify(vi.mocked(deps.logger.warning).mock.calls),
      ).not.toContain("private setup detail");
      deps.createSpeechRecognition = () => fake;
      deps.getLang = () => "en-US";
      await recorder.toggle();
      expect(recorder.getState()).toBe("browser");
    },
  );

  it.each(["provider-start", "provider-transcribe", "browser-start"])(
    "does not coerce or log the raw %s rejection",
    async (failure) => {
      const toString = vi.fn(() => {
        throw new Error("private error coercion");
      });
      const error = { toString };
      const fake = new FakeRecognition();
      const deps = baseDeps({ createSpeechRecognition: () => fake });
      if (failure === "provider-start") {
        // Only the start rejects: the reservation and the browser claim still
        // answer, which is what a working transport does.
        deps.invoke = nativeInvoke({
          start_recording: () => Promise.reject(error),
        });
      } else if (failure === "provider-transcribe") {
        deps.transcribe = vi.fn(() => Promise.reject(error));
      } else {
        deps.canUseProvider = () => false;
        fake.start = () => {
          throw error;
        };
      }
      const recorder = new VoiceInstructionRecorder(deps);
      await expect(recorder.toggle()).resolves.toBeUndefined();
      if (failure === "provider-transcribe")
        await expect(recorder.toggle()).resolves.toBeUndefined();
      expect(toString).not.toHaveBeenCalled();
      expect(deps.logger.warning).toHaveBeenCalled();
      expect(recorder.getState()).toBe(
        failure === "browser-start" ? "idle" : "browser",
      );
    },
  );

  it("contains a browser stop exception and detaches its stale callbacks", async () => {
    const fake = new FakeRecognition();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    fake.stop = () => {
      throw new Error("private stop detail");
    };
    await expect(recorder.toggle()).resolves.toBeUndefined();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onError).toHaveBeenCalledWith("unsupported");
    fake.emitResult("late result");
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(
      JSON.stringify(vi.mocked(deps.logger.warning).mock.calls),
    ).not.toContain("private stop detail");
  });

  it("does not throw from disposal when browser stop fails", async () => {
    const fake = new FakeRecognition();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    fake.stop = () => {
      throw new Error("private stop detail");
    };
    expect(() => recorder.dispose()).not.toThrow();
    expect(recorder.getState()).toBe("idle");
    fake.emitResult("late result");
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("accepts the final browser result after stop until the recognizer ends", async () => {
    const fake = new FakeRecognition();
    fake.stop = vi.fn();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    fake.emitResult("keep my final words");
    expect(deps.onTranscript).toHaveBeenCalledWith("keep my final words");
    fake.onend?.();
    fake.emitResult("obsolete words");
    expect(deps.onTranscript).toHaveBeenCalledTimes(1);
  });

  it("ignores old browser events after another recording starts", async () => {
    const old = new FakeRecognition();
    old.stop = vi.fn();
    const next = new FakeRecognition();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => old,
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    const oldEnd = old.onend;
    await recorder.toggle();
    deps.createSpeechRecognition = () => next;
    await recorder.toggle();
    old.emitResult("obsolete words");
    oldEnd?.();
    expect(recorder.getState()).toBe("browser");
    expect(deps.onTranscript).not.toHaveBeenCalled();
    next.emitResult("current words");
    expect(deps.onTranscript).toHaveBeenCalledWith("current words");
  });
});
