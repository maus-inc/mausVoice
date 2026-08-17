import { describe, expect, it, vi } from "vitest";
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

const baseDeps = (
  overrides: Partial<VoiceInstructionRecorderDeps> = {},
): VoiceInstructionRecorderDeps => {
  const fake = new FakeRecognition();
  return {
    invoke: vi.fn((cmd: string) => {
      if (cmd === "stop_recording") {
        return Promise.resolve({ samples: [0, 1], sampleRate: 16000 });
      }
      return Promise.resolve(undefined);
    }),
    transcribe: vi.fn().mockResolvedValue("transcript"),
    getPreferredMicrophone: () => null,
    createSpeechRecognition: () => fake,
    getLang: () => "en-US",
    canUseProvider: true,
    speechRecognitionSupported: true,
    unsupportedMessage: () => "unsupported",
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
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.reject(new Error("no mic"));
        return Promise.resolve(undefined);
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

  it("keeps listening active when provider transcription fails and browser fallback starts", async () => {
    const startedRecording = deferred<unknown>();
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording") return startedRecording.promise;
        if (cmd === "stop_recording")
          return Promise.reject(new Error("transcribe failed"));
        return Promise.resolve(undefined);
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const startPromise = recorder.toggle();
    startedRecording.resolve(undefined);
    await startPromise;
    // Give the start() continuation a tick to settle.
    await Promise.resolve();
    expect(recorder.getState()).toBe("provider");

    await recorder.toggle();
    // CRITICAL: after the transcription failure we fall back to the browser
    // recognizer, so the listening flag must NOT be reset to idle here.
    expect(recorder.getState()).toBe("browser");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(true);
    expect(deps.onResetLevels).toHaveBeenCalled();

    // A subsequent toggle stops the browser recognizer cleanly.
    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
  });

  it("rejects rapid duplicate starts (only one start_recording)", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording") return startDeferred.promise;
        return Promise.resolve(undefined);
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const first = recorder.toggle();
    const second = recorder.toggle();
    expect(deps.invoke).toHaveBeenCalledTimes(1);

    startDeferred.resolve(undefined);
    await Promise.all([first, second]);
    expect(recorder.getState()).toBe("provider");
  });

  it("disposes provider recording on unmount and resets levels", () => {
    const deps = baseDeps();
    const recorder = new VoiceInstructionRecorder(deps);

    return recorder.toggle().then(() => {
      expect(recorder.getState()).toBe("provider");
      recorder.dispose();
      expect(deps.invoke).toHaveBeenCalledWith("stop_recording");
      expect(recorder.getState()).toBe("idle");
      expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("disposes browser recognition on unmount", async () => {
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: () => fake,
      invoke: vi.fn((cmd) =>
        cmd === "start_recording"
          ? Promise.reject(new Error("no mic"))
          : Promise.resolve(undefined),
      ),
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
      canUseProvider: false,
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
      invoke: vi.fn((cmd) =>
        cmd === "start_recording"
          ? Promise.reject(new Error("no mic"))
          : Promise.resolve(undefined),
      ),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    fake.emitResult("make this shorter");
    expect(deps.onTranscript).toHaveBeenCalledWith("make this shorter");
  });
});
