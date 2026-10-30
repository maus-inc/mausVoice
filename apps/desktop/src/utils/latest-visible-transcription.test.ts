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
