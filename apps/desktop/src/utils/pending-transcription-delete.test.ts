import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteTranscription = vi.fn(async () => undefined);
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

const snapshot = {
  id: "t1",
  transcript: "hello",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdByUserId: "u1",
  isDeleted: false,
};

const memory = new Map<string, string>();

describe("pending transcription delete", () => {
  beforeEach(() => {
    vi.resetModules();
    deleteTranscription.mockReset().mockResolvedValue(undefined);
    memory.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    });
  });

  afterEach(() => {
    produceCalls.length = 0;
    deleteTranscription.mockClear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not call native delete until the undo window elapses", async () => {
    vi.useFakeTimers();
    const { scheduleTranscriptionDelete, undoTranscriptionDelete } =
      await import("./pending-transcription-delete");

    scheduleTranscriptionDelete(snapshot as never, 5000);
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

    scheduleTranscriptionDelete(snapshot as never, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleteTranscription).toHaveBeenCalledWith("t1");
  });

  it("persists queued ids so resume can finish a dropped flush", async () => {
    const { PENDING_DELETE_STORAGE_KEY, resumePendingTranscriptionDeletes } =
      await import("./pending-transcription-delete");

    memory.set(PENDING_DELETE_STORAGE_KEY, JSON.stringify(["t1"]));
    resumePendingTranscriptionDeletes();
    await Promise.resolve();
    expect(deleteTranscription).toHaveBeenCalledWith("t1");
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
