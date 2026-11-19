import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { StopRecordingResponse } from "../../types/transcription-session.types";
import { acquireLocalBrowserRecording } from "../../utils/local-recording-activity";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import {
  beginNativeRecording,
  currentNativeRecording,
  resetNativeRecordingSession,
  stopNativeRecording,
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

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Supply IPC replies; assertions on the sent tuples check the caller's ownership. */
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
    recordingUnavailableMessage: (operation) =>
      operation === "stop" ? "stop failed" : "recording unavailable",
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

const recorderFor = (deps: VoiceInstructionRecorderDeps) => {
  const recorder = new VoiceInstructionRecorder(deps);
  onTestFinished(() => recorder.dispose());
  return recorder;
};

// Exercise the clear latch and its subscribers, not database deletion.
const completeLocalClear = async () => {
  const release = await beginLocalDataClear();
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
};

const activeAdmission = () => {
  const handle = currentNativeRecording();
  if (!handle) throw new Error("Expected an active recording");
  return { ownerId: handle.ownerId, generation: handle.generation };
};

describe("VoiceInstructionRecorder", () => {
  it("starts provider recording, transcribes on stop, and returns to idle", async () => {
    const deps = baseDeps();
    const recorder = recorderFor(deps);

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
    const recorder = recorderFor(deps);

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
    const recorder = recorderFor(deps);

    const startPromise = recorder.toggle();
    startedRecording.resolve({ sampleRate: 16000 });
    await startPromise;
    // Give the start() continuation a tick to settle.
    await Promise.resolve();
    expect(recorder.getState()).toBe("provider");

    await recorder.toggle();
    // The failed stop leaves native holding the recorder, so starting the
    // browser recognizer here would open a second capture beside it. The
    // recorder stays idle and reports why instead — and the restored
    // native handle is discarded so the microphone does not stay live.
    expect(recorder.getState()).toBe("idle");
    expect(deps.onListeningChange).toHaveBeenLastCalledWith(false);
    expect(deps.onResetLevels).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith("stop failed");
    expect(createSpeechRecognition).not.toHaveBeenCalled();
    expect(deps.invoke).toHaveBeenCalledWith(
      "discard_recording",
      expect.objectContaining({ ownerId: expect.any(String) }),
    );
  });

  it("claims the native slot for browser recognition and releases it on stop", async () => {
    const fake = new FakeRecognition();
    fake.stop = vi.fn(() => fake.onend?.());
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = recorderFor(deps);

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

  it("keeps the native slot claimed until the recognizer reports end", async () => {
    const fake = new FakeRecognition();
    fake.stop = vi.fn();
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: () => fake,
    });
    const recorder = recorderFor(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("browser");

    const stopping = recorder.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stop request has been sent but `onend` has not arrived: the lease
    // must still hold the native slot so no other recording can start.
    expect(deps.invoke).not.toHaveBeenCalledWith(
      "release_browser_recording",
      expect.anything(),
    );
    fake.onend?.();
    await stopping;
    expect(recorder.getState()).toBe("idle");
    expect(deps.invoke).toHaveBeenCalledWith("release_browser_recording", {
      ownerId: expect.any(String),
      generation: 1,
    });
  });

  it.each(["dispose", "clear"])(
    "after %s, discards only the failed stop's admission before a replacement can record",
    async (invalidate) => {
      const entered = deferred();
      const stop = deferred<StopRecordingResponse>();
      const invoke = nativeInvoke({
        stop_recording: (args) => {
          if (args?.generation !== 1)
            return Promise.resolve({ samples: [0.75], sampleRate: 16_000 });
          entered.resolve();
          return stop.promise;
        },
      });
      const deps = baseDeps({ invoke });
      const recorder = recorderFor(deps);
      await recorder.toggle();
      const old = activeAdmission();
      const stopping = recorder.toggle();
      await entered.promise;
      if (invalidate === "dispose") recorder.dispose();
      else await completeLocalClear();

      const queued = beginNativeRecording(null, {}, invoke);
      const refused = expect(queued).rejects.toThrow("stop failed");
      stop.reject(new Error("stop failed"));
      await Promise.all([stopping, refused]);
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "discard_recording"),
      ).toEqual([["discard_recording", old]]);
      expect(currentNativeRecording()).toBeNull();
      expect(deps.transcribe).not.toHaveBeenCalled();
      expect(deps.onTranscript).not.toHaveBeenCalled();
      expect(deps.onError).not.toHaveBeenCalled();
      expect(deps.onResetLevels).not.toHaveBeenCalled();

      const { handle } = await beginNativeRecording(null, {}, invoke);
      expect(handle.ownerId).not.toBe(old.ownerId);
      expect(handle.generation).toBe(2);
      expect((await handle.stop()).samples).toEqual(Float32Array.of(0.75));
    },
  );

  it("cleans up its own admission when another stop of it is already pending", async () => {
    const entered = deferred();
    const stop = deferred<StopRecordingResponse>();
    const invoke = nativeInvoke({
      stop_recording: () => {
        entered.resolve();
        return stop.promise;
      },
    });
    const deps = baseDeps({ invoke });
    const recorder = recorderFor(deps);
    await recorder.toggle();
    const owner = activeAdmission();
    const external = expect(stopNativeRecording(invoke)).rejects.toThrow(
      "stop failed",
    );
    await entered.promise;
    const composer = recorder.toggle();
    stop.reject(new Error("stop failed"));
    await Promise.all([external, composer]);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "stop_recording"),
    ).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("discard_recording", owner);
    expect(currentNativeRecording()).toBeNull();
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it.each(["stop", "dispose"])(
    "an old composer's %s cannot consume the replacement recording",
    async (action) => {
      const invoke = nativeInvoke();
      const deps = baseDeps({ invoke });
      const recorder = recorderFor(deps);
      await recorder.toggle();
      const original = activeAdmission();
      const { handle } = await beginNativeRecording(null, {}, invoke);
      const replacement = activeAdmission();

      if (action === "stop") await recorder.toggle();
      else recorder.dispose();

      expect(deps.transcribe).not.toHaveBeenCalled();
      expect(deps.onTranscript).not.toHaveBeenCalled();
      expect(handle.isLive()).toBe(true);
      expect((await handle.stop()).samples).toEqual(Float32Array.of(0, 1));
      expect(
        invoke.mock.calls.filter(
          ([cmd]) => cmd === "discard_recording" || cmd === "stop_recording",
        ),
      ).toEqual([
        ["discard_recording", original],
        ["stop_recording", replacement],
      ]);
    },
  );

  it.each([true, false])(
    "refuses Voice Edit without discarding live audio (browser supported: %s)",
    async (speechRecognitionSupported) => {
      const invoke = nativeInvoke();
      const { handle } = await beginNativeRecording(null, {}, invoke);
      const deps = baseDeps({ invoke, speechRecognitionSupported });
      const recorder = recorderFor(deps);
      await recorder.toggle();
      expect(recorder.getState()).toBe("idle");
      expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
      expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
        "recording_generation",
        "start_recording",
      ]);
      expect((await handle.stop()).samples).toEqual(Float32Array.of(0, 1));
    },
  );

  it.each([true, false])(
    "reports a busy microphone in another window as retryable (browser supported: %s)",
    async (speechRecognitionSupported) => {
      // Tauri passes Rust's Err(String) through without constructing an Error.
      const invoke = nativeInvoke({
        start_recording: vi
          .fn()
          .mockRejectedValueOnce("A recording is already in progress")
          .mockResolvedValue({ sampleRate: 16_000 }),
      });
      const deps = baseDeps({ invoke, speechRecognitionSupported });
      const recorder = recorderFor(deps);
      await recorder.toggle();
      expect(deps.onError).toHaveBeenCalledExactlyOnceWith(
        "recording unavailable",
      );
      expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
        "recording_generation",
        "start_recording",
        "discard_recording",
      ]);
      await recorder.toggle();
      expect(recorder.getState()).toBe("provider");
    },
  );

  it("refuses browser recognition while a dictation holds the recorder", async () => {
    const deps = baseDeps({
      canUseProvider: () => false,
      createSpeechRecognition: vi.fn(() => null),
    });
    const recorder = recorderFor(deps);
    // A live native recording in this webview takes the same slot.
    await beginNativeRecording(null, {}, deps.invoke);

    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
    expect(deps.createSpeechRecognition).not.toHaveBeenCalled();
  });

  it("contains a teardown rejection and retries the unconfirmed admission", async () => {
    const discard = vi
      .fn()
      .mockRejectedValueOnce(new Error("device failed"))
      .mockResolvedValue(undefined);
    const invoke = nativeInvoke({ discard_recording: discard });
    const warning = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const recorder = recorderFor(baseDeps({ invoke, logger: { warning } }));
    await recorder.toggle();
    const admission = activeAdmission();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      recorder.dispose();
      // Node reports unhandled rejections after the current microtask queue.
      await nextTurn();
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "Voice Edit Mode: provider recording cleanup failed",
      );
      expect(unhandled).not.toHaveBeenCalled();
      const { handle } = await beginNativeRecording(null, {}, invoke);
      expect(discard.mock.calls).toEqual([[admission], [admission]]);
      expect(handle.generation).not.toBe(admission.generation);
      await handle.discard();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("retries an abandoned native release before opening a browser-only successor", async () => {
    let releaseWorks = false;
    const invoke = nativeInvoke({
      discard_recording: () =>
        releaseWorks
          ? Promise.resolve()
          : Promise.reject(new Error("release unconfirmed")),
    });
    const { handle } = await beginNativeRecording(null, {}, invoke);
    await expect(handle.discard()).rejects.toThrow("release unconfirmed");
    const browser = new FakeRecognition();
    const deps = baseDeps({
      invoke,
      canUseProvider: () => false,
      createSpeechRecognition: vi.fn(() => browser),
    });
    const recorder = recorderFor(deps);
    await recorder.toggle();
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
    expect(deps.createSpeechRecognition).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "claim_browser_recording",
      expect.anything(),
    );

    releaseWorks = true;
    await recorder.toggle();
    expect(invoke).toHaveBeenCalledWith("claim_browser_recording", {
      ownerId: expect.any(String),
      generation: 2,
    });
    browser.emitResult("new words");
    expect(deps.onTranscript).toHaveBeenCalledExactlyOnceWith("new words");
    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
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
    const recorder = recorderFor(deps);

    await recorder.toggle();
    expect(recorder.getState()).toBe("idle");
    expect(deps.onError).toHaveBeenCalledWith("recording unavailable");
  });

  it("rejects rapid duplicate starts (only one start_recording)", async () => {
    const startDeferred = deferred<unknown>();
    const deps = baseDeps({
      invoke: nativeInvoke({ start_recording: () => startDeferred.promise }),
    });
    const recorder = recorderFor(deps);

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
    const recorder = recorderFor(deps);

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
    const recorder = recorderFor(deps);

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
    const recorder = recorderFor(deps);

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
    const recorder = recorderFor(deps);

    await recorder.toggle();
    fake.emitResult("make this shorter");
    expect(deps.onTranscript).toHaveBeenCalledWith("make this shorter");
  });

  it("serializes a second toggle while stopping and issues a single stop_recording", async () => {
    const stopDeferred = deferred<StopRecordingResponse>();
    const deps = baseDeps({
      invoke: nativeInvoke({ stop_recording: () => stopDeferred.promise }),
    });
    const recorder = recorderFor(deps);

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

  it("does not transcribe a native stop reply received after disposal", async () => {
    const entered = deferred();
    const stop = deferred<StopRecordingResponse>();
    const deps = baseDeps({
      invoke: nativeInvoke({
        stop_recording: () => {
          entered.resolve();
          return stop.promise;
        },
      }),
    });
    const recorder = recorderFor(deps);
    await recorder.toggle();
    const stopping = recorder.toggle();
    await entered.promise;
    recorder.dispose();
    stop.resolve({ samples: [0, 1], sampleRate: 16_000 });
    await stopping;
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.onTranscript).not.toHaveBeenCalled();
    expect(deps.onResetLevels).not.toHaveBeenCalled();
    expect(recorder.getState()).toBe("idle");
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late transcription %s after dispose and remount",
    async (outcome) => {
      const entered = deferred();
      const oldText = deferred<string>();
      const invoke = nativeInvoke();
      const deps = baseDeps({
        invoke,
        transcribe: () => {
          entered.resolve();
          return oldText.promise;
        },
      });
      const old = recorderFor(deps);
      await old.toggle();
      const stopping = old.toggle();
      await entered.promise;
      old.dispose();

      const fresh = baseDeps({
        invoke,
        transcribe: vi.fn().mockResolvedValue("new words"),
      });
      const next = recorderFor(fresh);
      await next.toggle();
      const replacement = activeAdmission();
      if (outcome === "resolve") oldText.resolve("obsolete words");
      else oldText.reject(new Error("old transcription failed"));
      await stopping;

      expect(deps.onTranscript).not.toHaveBeenCalled();
      expect(deps.onError).not.toHaveBeenCalled();
      expect(deps.onResetLevels).not.toHaveBeenCalled();
      expect(deps.logger.warning).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalledWith("discard_recording", replacement);
      await next.toggle();
      expect(fresh.onTranscript).toHaveBeenCalledExactlyOnceWith("new words");
    },
  );

  it.each(["resolve", "reject"])(
    "stops a new recording after clear and ignores the old transcription's late %s",
    async (outcome) => {
      const entered = deferred();
      const oldText = deferred<string>();
      const invoke = nativeInvoke({
        stop_recording: (args) =>
          Promise.resolve({
            samples: [args?.generation === 1 ? 0.25 : 0.75],
            sampleRate: 16_000,
          }),
      });
      const deps = baseDeps({
        invoke,
        transcribe: ({ samples }) => {
          if (samples[0] === 0.75) return Promise.resolve("new words");
          expect(samples[0]).toBe(0.25);
          entered.resolve();
          return oldText.promise;
        },
      });
      const recorder = recorderFor(deps);
      await recorder.toggle();
      const stopping = recorder.toggle();
      await entered.promise;
      await completeLocalClear();
      await recorder.toggle();
      const replacement = activeAdmission();
      await recorder.toggle();
      if (outcome === "resolve") oldText.resolve("obsolete words");
      else oldText.reject(new Error("obsolete failure"));
      await stopping;

      expect(invoke).toHaveBeenCalledWith("stop_recording", replacement);
      expect(deps.onTranscript).toHaveBeenCalledExactlyOnceWith("new words");
      expect(deps.onResetLevels).toHaveBeenCalledOnce();
      expect(invoke).not.toHaveBeenCalledWith(
        "claim_browser_recording",
        expect.anything(),
      );
      expect(deps.onError).not.toHaveBeenCalled();
      expect(deps.logger.warning).not.toHaveBeenCalled();
      expect(recorder.getState()).toBe("idle");
      expect(currentNativeRecording()).toBeNull();
    },
  );

  it("does not strand an opening admission if another caller's stop fails before start returns", async () => {
    const opening = deferred();
    const start = deferred<{ sampleRate: number }>();
    const stop = deferred<StopRecordingResponse>();
    const stopping = deferred();
    const deps = baseDeps({
      invoke: nativeInvoke({
        start_recording: () => {
          opening.resolve();
          return start.promise;
        },
        stop_recording: () => {
          stopping.resolve();
          return stop.promise;
        },
      }),
    });
    const recorder = recorderFor(deps);
    const starting = recorder.toggle();
    await opening.promise;
    const owner = activeAdmission();
    const external = expect(stopNativeRecording(deps.invoke)).rejects.toThrow(
      "stop failed",
    );
    await stopping.promise;
    start.resolve({ sampleRate: 16_000 });
    // Separate IPC tasks: the continuations of the successful start run
    // before the failed stop reply, without guessing a timeout or tick count.
    setImmediate(() => stop.reject(new Error("stop failed")));
    await Promise.all([external, starting]);
    expect(deps.invoke).toHaveBeenCalledWith("discard_recording", owner);
    expect(currentNativeRecording()).toBeNull();
    expect(deps.onListeningChange).not.toHaveBeenCalled();
  });

  it("unblocks the microphone button without releasing a stalled native stop", async () => {
    vi.useFakeTimers();
    const opening = deferred();
    const start = deferred<{ sampleRate: number }>();
    const stop = deferred<StopRecordingResponse>();
    const invoke = nativeInvoke({
      start_recording: () => {
        opening.resolve();
        return start.promise;
      },
      stop_recording: () => stop.promise,
    });
    const deps = baseDeps({ invoke });
    const recorder = recorderFor(deps);
    const settled = vi.fn();
    const starting = recorder.toggle().then(settled);
    await opening.promise;
    const stopping = stopNativeRecording(invoke);
    start.resolve({ sampleRate: 16_000 });
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
        "recording_generation",
        "start_recording",
        "stop_recording",
      ]);
      expect(deps.onListeningChange).not.toHaveBeenCalled();
      expect(deps.onError).toHaveBeenCalledExactlyOnceWith(
        "recording unavailable",
      );
      expect(acquireLocalBrowserRecording(invoke, {})).toBe(false);
      expect(recorder.getState()).toBe("idle");
    } finally {
      stop.resolve({ samples: Float32Array.of(0.5), sampleRate: 16_000 });
      vi.useRealTimers();
      await starting;
    }
    expect((await stopping).samples).toEqual(Float32Array.of(0.5));
    await recorder.toggle();
    expect(recorder.getState()).toBe("provider");
  });

  it("starts a replacement after confirmed disposal, without an old start unlocking the next one", async () => {
    const opened = deferred();
    const replaced = deferred();
    const oldReply = deferred<{ sampleRate: number }>();
    const nextReply = deferred<{ sampleRate: number }>();
    const release = deferred();
    const invoke = nativeInvoke({
      start_recording: vi
        .fn()
        .mockImplementationOnce(() => {
          opened.resolve();
          return oldReply.promise;
        })
        .mockImplementationOnce(() => {
          replaced.resolve();
          return nextReply.promise;
        }),
      discard_recording: () => release.promise,
    });
    const old = recorderFor(baseDeps({ invoke }));
    const starting = old.toggle();
    await opened.promise;
    const admission = activeAdmission();
    old.dispose();
    const next = recorderFor(
      baseDeps({ invoke, speechRecognitionSupported: false }),
    );
    let replacement: Promise<void> | undefined;
    try {
      expect(invoke).toHaveBeenCalledWith("discard_recording", admission);
      await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
        "start is already in progress",
      );
      release.resolve();
      // Let the confirmed discard reply reach the session, without issuing
      // another discard from the test. The old start is still unanswered.
      await nextTurn();
      replacement = next.toggle();
      expect(
        await Promise.race([
          replaced.promise.then(() => "admitted"),
          replacement.then(() => "refused"),
        ]),
      ).toBe("admitted");
      oldReply.resolve({ sampleRate: 16_000 });
      await starting;
      await expect(beginNativeRecording(null, {}, invoke)).rejects.toThrow(
        "start is already in progress",
      );
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "recording_generation"),
      ).toHaveLength(2);
    } finally {
      release.resolve();
      oldReply.resolve({ sampleRate: 16_000 });
      nextReply.resolve({ sampleRate: 16_000 });
      await Promise.all([starting, replacement]);
    }
    expect(next.getState()).toBe("provider");
    expect(activeAdmission().generation).toBe(2);
  });

  it.each(["dispose", "clear"])(
    "%s discards the admission before a pending start replies",
    async (invalidate) => {
      const opening = deferred();
      const start = deferred<{ sampleRate: number }>();
      const invoke = nativeInvoke({
        start_recording: () => {
          opening.resolve();
          return start.promise;
        },
      });
      const deps = baseDeps({ invoke });
      const recorder = recorderFor(deps);
      const starting = recorder.toggle();
      await opening.promise;
      const admission = activeAdmission();
      if (invalidate === "dispose") recorder.dispose();
      else await completeLocalClear();
      const beforeReply = invoke.mock.calls.filter(
        ([cmd]) => cmd === "discard_recording",
      );
      start.resolve({ sampleRate: 16_000 });
      await starting;
      expect(beforeReply).toEqual([["discard_recording", admission]]);
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "discard_recording"),
      ).toEqual(beforeReply);
      expect(recorder.getState()).toBe("idle");
      expect(deps.onListeningChange).not.toHaveBeenCalled();
      expect(deps.onTranscript).not.toHaveBeenCalled();
      expect(deps.onError).not.toHaveBeenCalled();
    },
  );

  it("does not open capture when its reservation arrives after dispose", async () => {
    const reservation = deferred<number>();
    const invoke = nativeInvoke({
      recording_generation: () => reservation.promise,
    });
    const deps = baseDeps({ invoke });
    const recorder = recorderFor(deps);
    const starting = recorder.toggle();
    recorder.dispose();
    reservation.resolve(7);
    await starting;
    await recorder.toggle();
    const owner = invoke.mock.calls[0]?.[1]?.ownerId;
    expect(owner).toEqual(expect.any(String));
    expect(invoke.mock.calls).toEqual([
      ["recording_generation", { ownerId: owner }],
      ["discard_recording", { ownerId: owner, generation: 7 }],
    ]);
    expect(deps.onListeningChange).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
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
      const recorder = recorderFor(deps);
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
      const recorder = recorderFor(deps);
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
    const recorder = recorderFor(deps);
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
    const recorder = recorderFor(deps);
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
    const recorder = recorderFor(deps);
    await recorder.toggle();
    // The stop now waits for `onend`, so drive the end asynchronously and
    // deliver the final result while the stop is still pending.
    const stopping = recorder.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emitResult("keep my final words");
    expect(deps.onTranscript).toHaveBeenCalledWith("keep my final words");
    fake.onend?.();
    await stopping;
    expect(recorder.getState()).toBe("idle");
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
    const recorder = recorderFor(deps);
    await recorder.toggle();
    const oldEnd = old.onend;
    const stopping = recorder.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    old.onend?.();
    await stopping;
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
