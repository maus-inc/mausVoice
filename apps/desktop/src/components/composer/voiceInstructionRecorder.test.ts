import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { NativeRecordingLease } from "../../utils/native-recording-lease";
import {
  acquireLocalNativeRecording,
  releaseLocalNativeRecording,
} from "../../utils/local-recording-activity";
import {
  VoiceInstructionRecorder,
  type SpeechRecognitionLike,
  type VoiceInstructionRecorderDeps,
} from "./voiceInstructionRecorder";

const OWNERSHIP_ERRORS = [
  "A recording is already in progress",
  "Recording reset is in progress",
  "Recording admission is missing",
  "Recording admission was cancelled",
  "Recording admission was cancelled or already used",
  "Recording start was cancelled",
  "Recording window is closed",
];

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
  abort?: () => void;
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
  const delegate =
    overrides.invoke ??
    vi.fn((cmd: string) => {
      if (cmd === "stop_recording") {
        return Promise.resolve({ samples: [0, 1], sampleRate: 16000 });
      }
      if (cmd === "start_recording")
        return Promise.resolve({ sampleRate: 16000 });
      return Promise.resolve();
    });
  return {
    transcribe: vi.fn().mockResolvedValue("transcript"),
    getPreferredMicrophone: () => null,
    createSpeechRecognition: () => fake,
    getLang: () => "en-US",
    canUseProvider: () => true,
    speechRecognitionSupported: true,
    unsupportedMessage: () => "unsupported",
    recordingUnavailableMessage: () => "recording unavailable",
    captureFailedMessage: () => "capture failed",
    onListeningChange: vi.fn(),
    onTranscript: vi.fn(),
    onError: vi.fn(),
    onResetLevels: vi.fn(),
    logger: { warning: vi.fn() },
    ...overrides,
    invoke: vi.fn((cmd: string, args?: Record<string, unknown>) =>
      cmd === "recording_generation" ? Promise.resolve(0) : delegate(cmd, args),
    ),
    // Keep a single fake so tests can inspect the active recognizer.
    ...(overrides.createSpeechRecognition
      ? {}
      : { createSpeechRecognition: () => fake }),
  };
};

async function waitForBrowserRelease(
  invoke: VoiceInstructionRecorderDeps["invoke"],
) {
  const probe = {};
  await vi.waitFor(() =>
    expect(acquireLocalNativeRecording(invoke, probe)).toBe(true),
  );
  releaseLocalNativeRecording(invoke, probe);
}

describe("VoiceInstructionRecorder", () => {
  it("does not transcribe or fall back to browser speech for a partial capture", async () => {
    const recognition = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: () => recognition,
      invoke: vi.fn(async (command) =>
        command === "stop_recording"
          ? { samples: [0.5], sampleRate: 16000, captureFailed: true }
          : command === "start_recording"
            ? { sampleRate: 16000 }
            : undefined,
      ),
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    await recorder.toggle();
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("capture failed");
    expect(recognition.started).toBe(false);
    expect(recorder.getState()).toBe("idle");
  });

  it.each(["onTranscript", "onResetLevels"] as const)(
    "releases the provider state when %s throws",
    async (callback) => {
      const deps = baseDeps();
      const failure = new Error("UI callback failed");
      vi.mocked(deps[callback]).mockImplementation(() => {
        throw failure;
      });
      const recorder = new VoiceInstructionRecorder(deps);
      await recorder.toggle();
      await expect(recorder.toggle()).rejects.toBe(failure);
      expect(recorder.getState()).toBe("idle");
      expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
    },
  );

  it("releases provider state when reporting a transcription failure throws", async () => {
    const failure = new Error("error callback failed");
    const deps = baseDeps({
      speechRecognitionSupported: false,
      invoke: vi.fn((cmd) =>
        cmd === "stop_recording"
          ? Promise.reject(new Error("stop failed"))
          : Promise.resolve(
              cmd === "start_recording" ? { sampleRate: 16000 } : undefined,
            ),
      ),
      onError: () => {
        throw failure;
      },
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    await expect(recorder.toggle()).rejects.toBe(failure);
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps native ownership when the listening callback fails after start", async () => {
    const createSpeechRecognition = vi.fn(() => new FakeRecognition());
    const deps = baseDeps({ createSpeechRecognition });
    const failure = new Error("UI callback failed");
    vi.mocked(deps.onListeningChange).mockImplementationOnce(() => {
      throw failure;
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await expect(recorder.toggle()).rejects.toBe(failure);
    expect(recorder.getState()).toBe("provider");
    expect(createSpeechRecognition).not.toHaveBeenCalled();
    recorder.dispose();
    await vi.waitFor(() =>
      expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: expect.any(Number),
      }),
    );
  });

  it("does not reset levels after the transcript callback disposes the recorder", async () => {
    const deps = baseDeps();
    const recorder = new VoiceInstructionRecorder(deps);
    vi.mocked(deps.onTranscript).mockImplementation(() => recorder.dispose());
    await recorder.toggle();
    await recorder.toggle();
    expect(deps.onResetLevels).not.toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
    expect(
      vi
        .mocked(deps.invoke)
        .mock.calls.filter(([command]) => command === "stop_recording"),
    ).toHaveLength(1);
  });

  it("starts provider recording, transcribes on stop, and returns to idle", async () => {
    const deps = baseDeps();
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("provider");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(true);
    expect(deps.invoke).toHaveBeenCalledWith("start_recording", {
      args: { preferredMicrophone: null },
      ownerId: expect.any(String),
      generation: 0,
    });

    const ownerId = vi
      .mocked(deps.invoke)
      .mock.calls.find(
        ([command]) => command === "start_recording",
      )?.[1]?.ownerId;
    await recorder.toggle();
    expect(deps.invoke).toHaveBeenCalledWith("stop_recording", {
      ownerId,
      generation: expect.any(Number),
    });
    expect(deps.transcribe).toHaveBeenCalled();
    expect(deps.onTranscript).toHaveBeenCalledWith("transcript");
    expect(deps.onResetLevels).toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("waits for an uncertain native start to release before browser fallback", async () => {
    const cleanup = deferred<void>();
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: vi.fn(() => fake),
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.reject(new Error("response lost"));
        if (cmd === "discard_recording") return cleanup.promise;
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);
    const starting = recorder.toggle();
    await vi.waitFor(() =>
      expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: expect.any(Number),
      }),
    );
    expect(deps.createSpeechRecognition).not.toHaveBeenCalled();
    cleanup.resolve();
    await starting;
    expect(recorder.getState()).toBe("browser");
    expect(deps.createSpeechRecognition).toHaveBeenCalledOnce();
  });

  it("waits for cleanup after a malformed native start before browser fallback", async () => {
    const cleanup = deferred<void>();
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: vi.fn(() => fake),
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.resolve({ sampleRate: 0 });
        if (cmd === "discard_recording") return cleanup.promise;
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);
    const starting = recorder.toggle();
    await vi.waitFor(() =>
      expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: 0,
      }),
    );
    expect(deps.createSpeechRecognition).not.toHaveBeenCalled();
    cleanup.resolve();
    await starting;
    expect(recorder.getState()).toBe("browser");
    recorder.dispose();
  });

  it("does not open browser recognition if failed-stop cleanup cannot be confirmed", async () => {
    const createSpeechRecognition = vi.fn(() => new FakeRecognition());
    const deps = baseDeps({
      createSpeechRecognition,
      invoke: vi.fn((cmd) => {
        if (cmd === "stop_recording" || cmd === "discard_recording")
          return Promise.reject(new Error("transport unavailable"));
        if (cmd === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    await recorder.toggle();
    expect(createSpeechRecognition).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("unsupported");
    expect(recorder.getState()).toBe("idle");
  });

  it.each(OWNERSHIP_ERRORS)(
    "does not open browser recognition after ownership failure: %s",
    async (message) => {
      for (const error of [message, new Error(message)]) {
        const createSpeechRecognition = vi.fn(() => new FakeRecognition());
        const deps = baseDeps({
          createSpeechRecognition,
          invoke: vi.fn((cmd) =>
            cmd === "start_recording"
              ? Promise.reject(error)
              : Promise.resolve(),
          ),
        });
        const recorder = new VoiceInstructionRecorder(deps);
        await recorder.toggle();
        expect(createSpeechRecognition).not.toHaveBeenCalled();
        expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
        expect(recorder.getState()).toBe("idle");
      }
    },
  );

  it("does not fall back when reset rejects recording admission", async () => {
    const createSpeechRecognition = vi.fn(() => new FakeRecognition());
    const deps = baseDeps({ createSpeechRecognition });
    deps.invoke = vi.fn((command) =>
      command === "recording_generation"
        ? Promise.reject("Recording reset is in progress")
        : Promise.resolve(),
    );
    await new VoiceInstructionRecorder(deps).toggle();
    expect(createSpeechRecognition).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
  });

  it("tracks the native ownership errors that must not trigger fallback", () => {
    const native = ["platform/recording_ownership.rs", "commands.rs"]
      .map((file) =>
        readFileSync(
          new URL(`../../../src-tauri/src/${file}`, import.meta.url),
          "utf8",
        ),
      )
      .join("\n");
    for (const message of OWNERSHIP_ERRORS) {
      expect(native).toContain(`"${message}"`);
    }
  });

  it("fails closed if a rejected value cannot be inspected", async () => {
    const error = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("blocked");
        },
      },
    );
    const createSpeechRecognition = vi.fn(() => new FakeRecognition());
    const deps = baseDeps({
      createSpeechRecognition,
      invoke: vi.fn((cmd) =>
        cmd === "start_recording" ? Promise.reject(error) : Promise.resolve(),
      ),
    });
    await new VoiceInstructionRecorder(deps).toggle();
    expect(createSpeechRecognition).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
  });

  it("falls back to browser recognition when provider recording fails", async () => {
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.reject(new Error("no mic"));
        return Promise.resolve();
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
        return Promise.resolve();
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
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const first = recorder.toggle();
    const second = recorder.toggle();
    await Promise.resolve();
    expect(deps.invoke).toHaveBeenCalledTimes(2);

    startDeferred.resolve({ sampleRate: 16000 });
    await Promise.all([first, second]);
    expect(recorder.getState()).toBe("provider");
  });

  it("disposes provider recording on unmount and resets levels", async () => {
    const deps = baseDeps();
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    expect(recorder.getState()).toBe("provider");
    recorder.dispose();
    await vi.waitFor(() =>
      expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: expect.any(Number),
      }),
    );
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
  });

  it("disposes browser recognition on unmount", async () => {
    const fake = new FakeRecognition();
    const deps = baseDeps({
      createSpeechRecognition: () => fake,
      invoke: vi.fn((cmd) =>
        cmd === "start_recording"
          ? Promise.reject(new Error("no mic"))
          : Promise.resolve(),
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
      invoke: vi.fn((cmd) =>
        cmd === "start_recording"
          ? Promise.reject(new Error("no mic"))
          : Promise.resolve(),
      ),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    await recorder.toggle();
    fake.emitResult("make this shorter");
    expect(deps.onTranscript).toHaveBeenCalledWith("make this shorter");
  });

  it("serializes a second toggle while stopping and issues a single stop_recording", async () => {
    const stopDeferred = deferred<StopRecordingResponse>();
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (cmd === "stop_recording") return stopDeferred.promise;
        return Promise.resolve();
      }),
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
        if (cmd === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
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
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (cmd === "stop_recording") return stopDeferred.promise;
        return Promise.resolve();
      }),
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
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording")
          return Promise.resolve({ sampleRate: 16000 });
        if (cmd === "stop_recording") return stopDeferred.promise;
        return Promise.resolve();
      }),
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

  it("discards immediately when disposed while start_recording is pending", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording") return startDeferred.promise;
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const togglePromise = recorder.toggle();
    await Promise.resolve();
    // Dispose before the mic-open await resolves.
    recorder.dispose();
    expect(recorder.getState()).toBe("idle");

    await vi.waitFor(() =>
      expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
        ownerId: expect.any(String),
        generation: expect.any(Number),
      }),
    );
    startDeferred.resolve({ sampleRate: 16000 });
    await togglePromise;

    // The recorder must release the native mic instead of leaving it open.
    expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: expect.any(String),
      generation: expect.any(Number),
    });
    expect(recorder.getState()).toBe("idle");
    // No UI notification that listening started, no transcript delivered.
    expect(deps.onListeningChange).not.toHaveBeenCalled();
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it("discards admission and does not start after disposal", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: vi.fn((cmd) => {
        if (cmd === "start_recording") return startDeferred.promise;
        return Promise.resolve();
      }),
    });
    const recorder = new VoiceInstructionRecorder(deps);

    const togglePromise = recorder.toggle();
    recorder.dispose();
    startDeferred.resolve({ sampleRate: 16000 });
    await togglePromise;

    expect(recorder.getState()).toBe("idle");
    // A later toggle is a no-op because the recorder is disposed.
    await recorder.toggle();
    // Disposal before admission completes never opens the microphone.
    expect(deps.invoke).toHaveBeenCalledTimes(2);
    expect(deps.invoke).toHaveBeenCalledWith("discard_recording", {
      ownerId: expect.any(String),
      generation: expect.any(Number),
    });
    expect(deps.invoke).not.toHaveBeenCalledWith(
      "start_recording",
      expect.anything(),
    );
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
        deps.invoke = vi.fn((cmd) =>
          cmd === "recording_generation"
            ? Promise.resolve(0)
            : cmd === "discard_recording" ||
                cmd === "claim_browser_recording" ||
                cmd === "release_browser_recording"
              ? Promise.resolve()
              : Promise.reject(error),
        );
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

  it.each(["create", "language"] as const)(
    "does not start browser recognition when %s synchronously disposes the recorder",
    async (stage) => {
      const fake = new FakeRecognition();
      fake.abort = vi.fn();
      const deps = baseDeps({ canUseProvider: () => false });
      const recorder = new VoiceInstructionRecorder(deps);
      deps.createSpeechRecognition = () => {
        if (stage === "create") recorder.dispose();
        return fake;
      };
      deps.getLang = () => {
        if (stage === "language") recorder.dispose();
        return "en-US";
      };
      await recorder.toggle();
      expect(fake.started).toBe(false);
      expect(deps.onListeningChange).not.toHaveBeenCalledWith(true);
      await waitForBrowserRelease(deps.invoke);
    },
  );

  it.each(["missing", "throw"] as const)(
    "does not report a %s recognizer after its factory disposes the recorder",
    async (result) => {
      const deps = baseDeps({ canUseProvider: () => false });
      const recorder = new VoiceInstructionRecorder(deps);
      deps.createSpeechRecognition = () => {
        recorder.dispose();
        if (result === "throw") throw new Error("factory failed");
        return null;
      };
      await recorder.toggle();
      expect(deps.onError).not.toHaveBeenCalled();
      await waitForBrowserRelease(deps.invoke);
    },
  );

  it("blocks native capture until a disposed browser recognizer actually ends", async () => {
    const fake = new FakeRecognition();
    fake.stop = vi.fn();
    fake.abort = vi.fn();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
      invoke: vi.fn((command) =>
        command === "start_recording"
          ? Promise.resolve({ sampleRate: 16000 })
          : Promise.resolve(),
      ),
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    await recorder.toggle();
    recorder.dispose();
    expect(fake.abort).toHaveBeenCalledOnce();
    const lease = new NativeRecordingLease(deps.invoke, "after-browser");
    await expect(lease.start(null)).rejects.toThrow("already in progress");
    fake.onend?.();
    await waitForBrowserRelease(deps.invoke);
    await expect(lease.start(null)).resolves.toBeDefined();
    await lease.cancel();
  });

  it("does not report listening after a synchronous browser recognition error", async () => {
    const fake = new FakeRecognition();
    fake.start = () => fake.onerror?.();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onError).toHaveBeenCalledWith("unsupported");
    expect(deps.onListeningChange).not.toHaveBeenCalledWith(true);
    const lease = new NativeRecordingLease(deps.invoke, "after-error");
    await expect(lease.start(null)).rejects.toThrow("already in progress");
    fake.onend?.();
    await waitForBrowserRelease(deps.invoke);
    await lease.start(null);
    await lease.cancel();
  });

  it("keeps a disposed recognizer reserved across a composer remount", async () => {
    const old = new FakeRecognition();
    old.abort = vi.fn();
    const next = new FakeRecognition();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => old,
    });
    const first = new VoiceInstructionRecorder(deps);
    await first.toggle();
    first.dispose();
    deps.createSpeechRecognition = () => next;
    const second = new VoiceInstructionRecorder(deps);
    await second.toggle();
    expect(next.started).toBe(false);
    old.onend?.();
    await waitForBrowserRelease(deps.invoke);
    await second.toggle();
    expect(next.started).toBe(true);
    second.dispose();
  });

  it("blocks browser recognition while a native start is pending", async () => {
    const pending = deferred<unknown>();
    const fake = new FakeRecognition();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
      invoke: vi.fn((command) =>
        command === "start_recording" ? pending.promise : Promise.resolve(),
      ),
    });
    const lease = new NativeRecordingLease(deps.invoke, "native-first");
    const opening = lease.start(null);
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    expect(fake.started).toBe(false);
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
    pending.resolve({ sampleRate: 16000 });
    await opening;
    await lease.cancel();
    await recorder.toggle();
    expect(fake.started).toBe(true);
    recorder.dispose();
  });

  it("blocks browser recognition until an uncertain native start is discarded", async () => {
    const cleanup = deferred<unknown>();
    const fake = new FakeRecognition();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
      invoke: vi.fn((command) => {
        if (command === "start_recording")
          return Promise.reject("lost response");
        if (command === "discard_recording") return cleanup.promise;
        return Promise.resolve();
      }),
    });
    const lease = new NativeRecordingLease(deps.invoke, "uncertain-native");
    await expect(lease.start(null)).rejects.toBe("lost response");
    const recorder = new VoiceInstructionRecorder(deps);
    await recorder.toggle();
    expect(fake.started).toBe(false);
    cleanup.resolve(undefined);
    await lease.ensureReleasedAfterFailure();
    await recorder.toggle();
    expect(fake.started).toBe(true);
    recorder.dispose();
  });

  it("waits for the previous browser recognizer to end before starting another", async () => {
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
    expect(recorder.getState()).toBe("idle");
    expect(next.started).toBe(false);
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
    oldEnd?.();
    await waitForBrowserRelease(deps.invoke);
    await recorder.toggle();
    old.emitResult("obsolete words");
    oldEnd?.();
    expect(recorder.getState()).toBe("browser");
    expect(deps.onTranscript).not.toHaveBeenCalled();
    next.emitResult("current words");
    expect(deps.onTranscript).toHaveBeenCalledWith("current words");
  });
});
