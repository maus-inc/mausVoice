import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("pending transcription delete", () => {
  afterEach(() => {
    produceCalls.length = 0;
    deleteTranscription.mockClear();
    vi.useRealTimers();
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
    const { scheduleTranscriptionDelete } = await import(
      "./pending-transcription-delete"
    );

    scheduleTranscriptionDelete(snapshot as never, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleteTranscription).toHaveBeenCalledWith("t1");
  });
});
