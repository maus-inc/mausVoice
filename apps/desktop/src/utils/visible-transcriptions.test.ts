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
  getAppState: () => mocks.state,
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

  it("keeps a session-only memory row listed across a repository refresh", async () => {
    const sessionOnly = await import("./session-only-transcriptions");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const persisted = row("one");
    const memory: Transcription = {
      ...row("memory"),
      createdAt: "2026-09-25T13:00:00.000Z",
    };
    mocks.state.transcriptionById = { memory };
    mocks.state.transcriptions.transcriptionIds = ["memory"];
    sessionOnly.markTranscriptionSessionOnly("memory");
    mocks.list.mockResolvedValue([persisted]);

    await refreshVisibleTranscriptions(() => true);

    // The repository never sees the incognito memory row, so a plain
    // replacement would drop it from History mid-session. The newer memory
    // row keeps its place above the older persisted row.
    expect(mocks.state.transcriptions.transcriptionIds).toEqual([
      "memory",
      "one",
    ]);
    expect(mocks.state.transcriptionById.memory).toBeDefined();
  });

  it("orders an older session-only row below newer persisted rows", async () => {
    const sessionOnly = await import("./session-only-transcriptions");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const newer: Transcription = {
      ...row("newer"),
      createdAt: "2026-09-25T14:00:00.000Z",
    };
    const older = row("older");
    const memory: Transcription = {
      ...row("memory"),
      createdAt: "2026-09-25T13:00:00.000Z",
    };
    mocks.state.transcriptionById = { memory };
    sessionOnly.markTranscriptionSessionOnly("memory");
    mocks.list.mockResolvedValue([newer, older]);

    await refreshVisibleTranscriptions(() => true);

    expect(mocks.state.transcriptions.transcriptionIds).toEqual([
      "newer",
      "memory",
      "older",
    ]);
  });

  it("drops a session-only row once its record leaves the state", async () => {
    const sessionOnly = await import("./session-only-transcriptions");
    const pending = await import("./pending-transcription-delete");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const memory = row("memory");
    mocks.state.transcriptionById = { memory };
    sessionOnly.markTranscriptionSessionOnly("memory");
    mocks.list.mockResolvedValue([]);

    await refreshVisibleTranscriptions(() => true);
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["memory"]);

    // A delete removes the record from the state; the registry id alone must
    // not keep a deleted row listed.
    pending.scheduleTranscriptionDelete(memory, 5000);
    await refreshVisibleTranscriptions(() => true);
    expect(mocks.state.transcriptions.transcriptionIds).toEqual([]);
  });

  it("preserves a newer recovery result when an older list returns", async () => {
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const pending = deferred<Transcription[]>();
    const old = row("one");
    mocks.state.transcriptionById = { one: old };
    mocks.list.mockReturnValueOnce(pending.promise);
    const refresh = refreshVisibleTranscriptions(() => true);
    mocks.state.transcriptionById = {
      one: { ...old, transcript: "recovered" },
    };
    pending.resolve([old]);
    await refresh;
    expect(mocks.state.transcriptionById.one.transcript).toBe("recovered");
    expect(mocks.state.transcriptions.transcriptionIds).toEqual(["one"]);
  });

  it("discards a list that returns after local data was cleared", async () => {
    const gate = await import("./local-data-write-gate");
    const { refreshVisibleTranscriptions } =
      await import("./visible-transcriptions");
    const pending = deferred<Transcription[]>();
    mocks.list.mockReturnValueOnce(pending.promise);
    const refresh = refreshVisibleTranscriptions(() => true);
    const release = await gate.beginLocalDataClear();
    localStorage.removeItem(gate.LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    release();
    pending.resolve([row("before-clear")]);
    await refresh;
    expect(mocks.state.transcriptions.transcriptionIds).toEqual([]);
    expect(mocks.state.transcriptionById["before-clear"]).toBeUndefined();
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
