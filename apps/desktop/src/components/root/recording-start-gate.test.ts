// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
import {
  beginLocalDataClear,
  getLocalDataClearGeneration,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import { resetNativeRecordingSession } from "../../utils/native-recording-session";
import {
  admittedStartOptions,
  attemptStillOwns,
  invokeGuardedRecordingStart,
  settleRecordingStart,
  subscribeRecordingAbortForClear,
} from "./recording-start-gate";

beforeEach(() => {
  resetNativeRecordingSession();
  invoke.mockReset();
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

it("retains the handle at admission, before the start reply lands", async () => {
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
  const retained: unknown[] = [];
  const start = invokeGuardedRecordingStart(
    null,
    admittedStartOptions(
      () => true,
      (handle) => retained.push(handle),
    ),
  );
  // The handle arrives while `start_recording` is still unanswered, so a caller
  // can stop the device during the opening window.
  await vi.waitFor(() => expect(retained).toHaveLength(1));
  expect(
    invoke.mock.calls.filter(([command]) => command === "start_recording"),
  ).toHaveLength(1);
  finishStart({ sampleRate: 16000 });
  const { handle } = await start;
  expect(retained[0]).toBe(handle);
});

it("retires the reservation instead of dispatching a stale start", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "recording_generation") return Promise.resolve(1);
    return Promise.resolve({ sampleRate: 16000 });
  });
  const retained: unknown[] = [];
  await expect(
    invokeGuardedRecordingStart(
      null,
      admittedStartOptions(
        () => false,
        (handle) => retained.push(handle),
      ),
    ),
  ).rejects.toThrow("Recording start was cancelled");
  // The cancelled attempt never retained a handle and never opened the device.
  expect(retained).toHaveLength(0);
  expect(
    invoke.mock.calls.filter(([command]) => command === "start_recording"),
  ).toHaveLength(0);
});

/** Ownership reads live refs, so each case drives them through one mutable record. */
const ownershipOf = (mounted: boolean, opId: number) => ({
  isMounted: () => mounted,
  currentOpId: () => opId,
});

it("lets the newest attempt on a mounted form publish its state", () => {
  const generation = getLocalDataClearGeneration();
  expect(attemptStillOwns(ownershipOf(true, 3), 3, generation)).toBe(true);
});

it("rejects an attempt that a newer start or stop has superseded", () => {
  // The op id is bumped by every start and every stop, so an older reply must
  // not publish over the state the newer attempt already set.
  const generation = getLocalDataClearGeneration();
  expect(attemptStillOwns(ownershipOf(true, 4), 3, generation)).toBe(false);
});

it("rejects an attempt whose component unmounted while it opened", () => {
  const generation = getLocalDataClearGeneration();
  expect(attemptStillOwns(ownershipOf(false, 3), 3, generation)).toBe(false);
});

it("rejects an attempt admitted before a local-data clear began", async () => {
  const admittedGeneration = getLocalDataClearGeneration();
  expect(attemptStillOwns(ownershipOf(true, 1), 1, admittedGeneration)).toBe(
    true,
  );
  const release = await beginLocalDataClear();
  // A clear invalidates every attempt, so the generation it was admitted under
  // no longer matches even though the op id is unchanged.
  expect(attemptStillOwns(ownershipOf(true, 1), 1, admittedGeneration)).toBe(
    false,
  );
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
});
