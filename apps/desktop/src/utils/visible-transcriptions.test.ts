// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
  state: {
    transcriptionById: {} as Record<string, Transcription>,
    transcriptions: { transcriptionIds: [] as string[] },
  },
}));
vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({
    listTranscriptions: mocks.list,
    deleteTranscription: mocks.remove,
  }),
}));
vi.mock("../store", () => ({
  produceAppState: (fn: (state: typeof mocks.state) => void) => fn(mocks.state),
}));
vi.mock("../actions/app.actions", () => ({ showErrorSnackbar: mocks.error }));
vi.mock("./app.utils", () => ({
  registerTranscriptions: (
    state: typeof mocks.state,
    rows: Transcription[],
  ) => {
    for (const row of rows) state.transcriptionById[row.id] = row;
  },
}));
const row = (id: string): Transcription => ({
  id,
  createdAt: "2026-09-25T12:00:00.000Z",
  createdByUserId: "user",
  transcript: id,
  isDeleted: false,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("visible transcription loads", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    localStorage.clear();
    mocks.list.mockReset();
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.error.mockReset();
    mocks.state.transcriptionById = {};
    mocks.state.transcriptions.transcriptionIds = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("hides a pending deletion during reload and includes it again after undo", async () => {
    const pending = await import("./pending-transcription-delete");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const one = row("one"),
      two = row("two");
    mocks.list.mockResolvedValue([one, two]);
    await refreshVisibleTranscriptions(() => true);
    pending.scheduleTranscriptionDelete(one, 5000);
    await refreshVisibleTranscriptions(() => true);
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["two"]);
    expect(pending.undoTranscriptionDelete("one")).toBe(true);
    await refreshVisibleTranscriptions(() => true);
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["one", "two"]);
  });

  it("retries a stale list captured before the delete committed", async () => {
    const pending = await import("./pending-transcription-delete");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const one = row("one"),
      two = row("two"),
      stale = deferred<Transcription[]>();
    mocks.list.mockReturnValueOnce(stale.promise).mockResolvedValueOnce([two]);
    const refresh = refreshVisibleTranscriptions(() => true);
    pending.scheduleTranscriptionDelete(one, 5000);
    await vi.advanceTimersByTimeAsync(5000);
    stale.resolve([one, two]);
    await refresh;
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["two"]);
  });

  it("does not apply a load after its page unmounts", async () => {
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const delayed = deferred<Transcription[]>();
    mocks.list.mockReturnValue(delayed.promise);
    let active = true;
    const refresh = refreshVisibleTranscriptions(() => active);
    active = false;
    delayed.resolve([row("one")]);
    await refresh;
    expect(mocks.state.transcriptions.transcriptionIds).toEqual([]);
  });

  it("hides the persisted delete queue before startup resume runs", async () => {
    localStorage.setItem(
      "mausvoice.pending-transcription-deletes",
      JSON.stringify(["one"]),
    );
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    mocks.list.mockResolvedValue([row("one"), row("two")]);
    await refreshVisibleTranscriptions(() => true);
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["two"]);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("retries when undo happens while a stale list is loading", async () => {
    const pending = await import("./pending-transcription-delete");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const one = row("one"),
      delayed = deferred<Transcription[]>();
    pending.scheduleTranscriptionDelete(one, 5000);
    mocks.list
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce([one]);
    const refresh = refreshVisibleTranscriptions(() => true);
    pending.undoTranscriptionDelete("one");
    delayed.resolve([]);
    await refresh;
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["one"]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
