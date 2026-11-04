// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../../utils/local-data-write-gate";
import { invokeGuardedRecordingStart } from "./recording-start-gate";

it("drains a native microphone start before allowing a clear, and rejects later starts", async () => {
  let finishStart!: (value: { sampleRate: number }) => void;
  invoke.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = resolve;
      }),
  );
  const start = invokeGuardedRecordingStart<{ sampleRate: number }>(null);
  let clearReady = false;
  const clearing = beginLocalDataClear().then((release) => {
    clearReady = true;
    return release;
  });
  await Promise.resolve();
  expect(clearReady).toBe(false);
  await expect(invokeGuardedRecordingStart(null)).rejects.toThrow();
  expect(invoke).toHaveBeenCalledTimes(1);
  finishStart({ sampleRate: 16000 });
  expect(await start).toEqual({ sampleRate: 16000 });
  const release = await clearing;
  expect(clearReady).toBe(true);
  localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  release();
});
