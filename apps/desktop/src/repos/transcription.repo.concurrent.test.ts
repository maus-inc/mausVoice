import { expect, it, vi } from "vitest";
import type { Transcription } from "@maus-inc/types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/user.utils", () => ({ getMyEffectiveUserId: () => "user" }));
vi.mock("./base.repo", () => ({
  BaseRepo: class {},
  withLocalDataWrite: (operation: () => Promise<unknown>) => operation(),
}));

import { LocalTranscriptionRepo } from "./transcription.repo";
import {
  transcriptionCreationRevision,
  waitForTranscriptionCreations,
} from "../utils/transcription-creation-tracker";

it("tracks native creation until it settles, including failures", async () => {
  let reject!: (error: Error) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const repo = new LocalTranscriptionRepo();
  const before = transcriptionCreationRevision();
  const creation = repo.createTranscription({
    id: "new",
    transcript: "new",
    createdAt: new Date().toISOString(),
  } as Transcription);
  const failed = expect(creation).rejects.toThrow("create failed");
  expect(transcriptionCreationRevision()).toBeGreaterThan(before);
  let drained = false;
  const waiting = waitForTranscriptionCreations().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  reject(new Error("create failed"));
  await failed;
  await waiting;
  expect(drained).toBe(true);
  expect(transcriptionCreationRevision()).toBeGreaterThan(before + 1);
});
