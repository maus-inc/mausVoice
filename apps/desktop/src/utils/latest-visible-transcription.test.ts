import { beforeEach, expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  revision: 0,
  pending: new Set<string>(),
}));
vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ listTranscriptions: mocks.list }),
}));
vi.mock("./pending-transcription-delete", () => ({
  getTranscriptionDeletionRevision: () => mocks.revision,
  isTranscriptionPendingDelete: (id: string) => mocks.pending.has(id),
}));
import { latestVisibleTranscription } from "./latest-visible-transcription";
import { trackTranscriptionCreation } from "./transcription-creation-tracker";
const row = (id: string) => ({ id, transcript: id }) as Transcription;
beforeEach(() => {
  mocks.list.mockReset();
  mocks.pending.clear();
  mocks.revision = 0;
});
it("skips a pending latest deletion to find the next visible transcript", async () => {
  mocks.pending.add("a");
  mocks.list.mockResolvedValue([row("a"), row("b")]);
  expect((await latestVisibleTranscription())?.id).toBe("b");
});
it("continues beyond a full page of pending items", async () => {
  const page = Array.from({ length: 20 }, (_, i) => row(String(i)));
  page.forEach((r) => mocks.pending.add(r.id));
  mocks.list.mockResolvedValueOnce(page).mockResolvedValueOnce([row("next")]);
  expect((await latestVisibleTranscription())?.id).toBe("next");
  expect(mocks.list).toHaveBeenLastCalledWith({ limit: 20, offset: 20 });
});
it("restarts when a deletion changes while the repository is loading", async () => {
  mocks.list
    .mockImplementationOnce(async () => {
      mocks.pending.add("a");
      mocks.revision++;
      return [row("a"), row("b")];
    })
    .mockResolvedValueOnce([row("a"), row("b")]);
  expect((await latestVisibleTranscription())?.id).toBe("b");
  expect(mocks.list).toHaveBeenCalledTimes(2);
});
it("returns no result when every row is pending", async () => {
  mocks.pending.add("a");
  mocks.list.mockResolvedValue([row("a")]);
  expect(await latestVisibleTranscription()).toBeUndefined();
});
it("restarts from the first page if a creation shifts offsets between pages", async () => {
  const page = Array.from({ length: 20 }, (_, i) => row(String(i)));
  page.forEach((r) => mocks.pending.add(r.id));
  mocks.list
    .mockResolvedValueOnce(page)
    .mockImplementationOnce(async () => {
      await trackTranscriptionCreation(async () => undefined);
      return [page[19], row("older")];
    })
    .mockResolvedValueOnce([row("new"), ...page.slice(0, 19)]);
  expect((await latestVisibleTranscription())?.id).toBe("new");
  expect(mocks.list.mock.calls.map(([params]) => params.offset)).toEqual([
    0, 20, 0,
  ]);
});
it("waits for a creation already in flight before reading", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const creation = trackTranscriptionCreation(() => pending);
  mocks.list.mockResolvedValue([row("new")]);
  const latest = latestVisibleTranscription();
  try {
    await Promise.resolve();
    expect(mocks.list).not.toHaveBeenCalled();
  } finally {
    finish();
    await creation;
  }
  expect((await latest)?.id).toBe("new");
});
it("waits for a creation that begins during a page read before accepting it", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let creation: Promise<void> | undefined;
  mocks.list
    .mockImplementationOnce(async () => {
      creation = trackTranscriptionCreation(() => pending);
      return [row("old")];
    })
    .mockResolvedValueOnce([row("new")]);
  let result: Transcription | undefined;
  const read = latestVisibleTranscription().then((value) => {
    result = value;
  });
  try {
    await vi.waitFor(() => expect(creation).toBeDefined());
    expect(result).toBeUndefined();
  } finally {
    finish();
    await read;
  }
  expect(result?.id).toBe("new");
});
