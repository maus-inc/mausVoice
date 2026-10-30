// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleTranscription } from "../test/helpers/transcription-fixture";
import { LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY } from "./local-data-write-gate";

const deleteTranscription = vi.fn(
  async (..._args: unknown[]): Promise<void> => undefined,
);
const produceCalls: Array<(draft: { ids: string[] }) => void> = [];

vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ deleteTranscription }),
}));

vi.mock("../store", () => ({
  produceAppState: (fn: (draft: { ids: string[] }) => void) => {
    produceCalls.push(fn);
  },
}));

vi.mock("../actions/app.actions", () => ({
  showErrorSnackbar: vi.fn(),
}));

const snapshot = sampleTranscription("t1");
const memory = new Map<string, string>();

vi.mock("../utils/local-storage.utils", () => ({
  getLocalStorage: () => ({
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
    get length() {
      return memory.size;
    },
    key: (index: number) => [...memory.keys()][index] ?? null,
  }),
}));

describe("pending transcription delete", () => {
  beforeEach(() => {
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    vi.resetModules();
    deleteTranscription.mockReset().mockResolvedValue(undefined);
    memory.clear();
  });

  afterEach(() => {
    window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    produceCalls.length = 0;
    deleteTranscription.mockClear();
    vi.useRealTimers();
  });

  it("does not call native delete until the undo window elapses", async () => {
    vi.useFakeTimers();
    const { scheduleTranscriptionDelete, undoTranscriptionDelete } =
      await import("./pending-transcription-delete");

    scheduleTranscriptionDelete(snapshot, 5000);
    expect(deleteTranscription).not.toHaveBeenCalled();

    const undone = undoTranscriptionDelete("t1");
    expect(undone).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleteTranscription).not.toHaveBeenCalled();
  });

  it("commits delete after the window", async () => {
    vi.useFakeTimers();
    const { scheduleTranscriptionDelete } =
      await import("./pending-transcription-delete");

    scheduleTranscriptionDelete(snapshot, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleteTranscription).toHaveBeenCalledWith("t1", expect.any(Object));
  });

  it("does not restore a pending snapshot into memory after clear starts", async () => {
    vi.useFakeTimers();
    const { beginLocalDataClear } = await import("./local-data-write-gate");
    const { scheduleTranscriptionDelete } =
      await import("./pending-transcription-delete");

    scheduleTranscriptionDelete(snapshot, 5000);
    const storeUpdatesBeforeClear = produceCalls.length;
    const releaseClear = await beginLocalDataClear();

    try {
      await vi.advanceTimersByTimeAsync(5000);

      expect(deleteTranscription).not.toHaveBeenCalled();
      expect(produceCalls).toHaveLength(storeUpdatesBeforeClear);
    } finally {
      window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }
  });

  it("persists queued ids so resume can finish a dropped flush", async () => {
    const { PENDING_DELETE_STORAGE_KEY, resumePendingTranscriptionDeletes } =
      await import("./pending-transcription-delete");

    memory.set(PENDING_DELETE_STORAGE_KEY, JSON.stringify(["t1"]));
    resumePendingTranscriptionDeletes();
    await Promise.resolve();
    expect(deleteTranscription).toHaveBeenCalledWith("t1", expect.any(Object));
  });

  it("holds the pagehide lease until queued delete follow-up writes settle", async () => {
    vi.useFakeTimers();
    const { beginLocalDataClear } = await import("./local-data-write-gate");
    const {
      flushPendingTranscriptionDeletes,
      resumePendingTranscriptionDeletes,
      scheduleTranscriptionDelete,
    } = await import("./pending-transcription-delete");

    let finishDelete: (() => void) | undefined;
    deleteTranscription.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );

    scheduleTranscriptionDelete(snapshot, 5000);
    resumePendingTranscriptionDeletes();
    flushPendingTranscriptionDeletes();
    expect(deleteTranscription).toHaveBeenCalledWith("t1", expect.any(Object));

    let clearReady = false;
    let releaseClear: (() => void) | undefined;
    const clearing = beginLocalDataClear().then((release) => {
      releaseClear = release;
      clearReady = true;
      return release;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(clearReady).toBe(false);
      finishDelete?.();
      await clearing;
      expect(clearReady).toBe(true);
    } finally {
      finishDelete?.();
      if (!releaseClear) releaseClear = await clearing;
      window.localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    }
  });

  it("retains a failed resumed delete and retries it on the next launch", async () => {
    deleteTranscription.mockRejectedValueOnce(
      new Error("native deletion failed"),
    );
    const first = await import("./pending-transcription-delete");
    memory.set(first.PENDING_DELETE_STORAGE_KEY, JSON.stringify(["t1"]));
    first.resumePendingTranscriptionDeletes();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      JSON.parse(memory.get(first.PENDING_DELETE_STORAGE_KEY) ?? "[]"),
    ).toEqual(["t1"]);
    vi.resetModules();
    const next = await import("./pending-transcription-delete");
    next.resumePendingTranscriptionDeletes();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteTranscription).toHaveBeenCalledTimes(2);
    expect(memory.has(first.PENDING_DELETE_STORAGE_KEY)).toBe(false);
  });
});
