// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/api/window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/window")>()),
  getCurrentWindow: () => ({ label: "main" }),
}));
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import { ActivationController } from "../../utils/activation.utils";
import { resetNativeRecordingSession } from "../../utils/native-recording-session";
import {
  assertDictationStartAvailable,
  bindRecordingActivation,
  invokeGuardedRecordingStart,
  settleRecordingStart,
  subscribeRecordingAbortForClear,
} from "./recording-start-gate";

beforeEach(() => {
  resetNativeRecordingSession();
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
});

it("drains a native microphone start before allowing a clear, and rejects later starts", async () => {
  let finishStart!: (value: { sampleRate: number }) => void;
  invoke.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(1);
    return new Promise((resolve) => {
      finishStart = resolve;
    });
  });
  const start = invokeGuardedRecordingStart(null);
  let clearReady = false;
  const clearing = beginLocalDataClear().then((release) => {
    clearReady = true;
    return release;
  });
  await Promise.resolve();
  expect(clearReady).toBe(false);
  await expect(invokeGuardedRecordingStart(null)).rejects.toThrow();
  // Only the admitted start reached native; the rejected one never opened a
  // microphone, so it asked for no generation.
  expect(
    invoke.mock.calls.filter(([command]) => command === "start_recording"),
  ).toHaveLength(1);
  finishStart({ sampleRate: 16000 });
  expect(await start).toEqual({ sampleRate: 16000, handle: expect.anything() });
  const release = await clearing;
  expect(clearReady).toBe(true);
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
});

it("aborts an active recording as soon as clear is requested, even before native startup finishes", async () => {
  let finishStart!: (value: { sampleRate: number }) => void;
  invoke.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(1);
    if (command === "start_recording") {
      return new Promise((resolve) => {
        finishStart = resolve;
      });
    }
    return Promise.resolve(undefined);
  });
  const start = invokeGuardedRecordingStart(null);
  const abort = vi.fn(async () => {});
  const unsubscribe = subscribeRecordingAbortForClear(() => true, abort);
  // The admission is requested first, so the microphone open is dispatched a
  // microtask later; wait for it before releasing it.
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("start_recording", expect.anything()),
  );
  const clearing = beginLocalDataClear();
  expect(abort).toHaveBeenCalledOnce();
  finishStart({ sampleRate: 16000 });
  await start;
  const release = await clearing;
  unsubscribe();
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
});

it("does not abort an idle recording and unregisters the clear listener", async () => {
  const abort = vi.fn(async () => {});
  let active = false;
  const unsubscribe = subscribeRecordingAbortForClear(() => active, abort);
  const release = await beginLocalDataClear();
  expect(abort).not.toHaveBeenCalled();
  unsubscribe();
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
  active = true;
  const releaseAgain = await beginLocalDataClear();
  expect(abort).not.toHaveBeenCalled();
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  releaseAgain();
});

it("stops a late microphone start after a parallel startup step has failed", async () => {
  let finish!: (value: string) => void;
  const nativeStart = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const stop = vi.fn(async () => {});
  const started = vi.fn();
  let current = true;
  const tracked = settleRecordingStart(
    nativeStart,
    () => current,
    started,
    stop,
  );
  const combined = Promise.all([
    Promise.reject(new Error("phase failed")),
    tracked,
  ]);
  await expect(combined).rejects.toThrow("phase failed");
  current = false;
  finish("started");
  await expect(tracked).resolves.toBe("started");
  expect(stop).toHaveBeenCalledOnce();
  expect(started).not.toHaveBeenCalled();
});

const drain = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("recording shortcut ownership", () => {
  it("keeps the first startup and ignores release of a rejected shortcut", async () => {
    let operation = 0;
    let active = false;
    let finishStart!: () => void;
    const loading = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const stop = vi.fn(async () => {
      active = false;
    });
    const makeShortcut = () => {
      const activation = bindRecordingActivation(
        async (claim) => {
          assertDictationStartAvailable(active, false);
          active = true;
          claim(++operation);
          await loading;
        },
        () => operation,
        stop,
      );
      return new ActivationController(activation.start, activation.stop, true);
    };
    const first = makeShortcut();
    const competitor = makeShortcut();
    first.handlePress();
    await drain();
    competitor.handlePress();
    competitor.handleRelease();
    await drain();
    expect(competitor.isActive).toBe(false);
    expect(operation).toBe(1);
    expect(stop).not.toHaveBeenCalled();
    first.handleRelease();
    finishStart();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("ignores controls from an unclaimed or superseded shortcut", async () => {
    let operation = 1;
    const stop = vi.fn(async () => {});
    const ignored = bindRecordingActivation(
      async () => {},
      () => operation,
      stop,
    );
    await ignored.start();
    await ignored.stop();
    const old = bindRecordingActivation(
      async (claim) => claim(operation),
      () => operation,
      stop,
    );
    await old.start();
    operation += 1;
    await old.stop();
    expect(stop).not.toHaveBeenCalled();
    expect(() => assertDictationStartAvailable(false, true)).toThrow();
  });
});
