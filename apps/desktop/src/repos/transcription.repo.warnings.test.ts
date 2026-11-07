import { expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/user.utils", () => ({ getMyEffectiveUserId: () => "user" }));
vi.mock("../utils/transcription-creation-tracker", () => ({
  trackTranscriptionCreation: (operation: () => Promise<unknown>) =>
    operation(),
}));
vi.mock("./base.repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./base.repo")>();
  return {
    ...actual,
    withLocalDataWrite: (operation: () => Promise<unknown>) => operation(),
  };
});

import { LocalTranscriptionRepo } from "./transcription.repo";

it("uses the warning-only native command and returns the latest warnings", async () => {
  invoke.mockResolvedValueOnce(["existing", "delivery failed"]);

  await expect(
    new LocalTranscriptionRepo().appendWarnings("row-1", ["delivery failed"]),
  ).resolves.toEqual(["existing", "delivery failed"]);

  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "transcription_append_warnings",
    { id: "row-1", warnings: ["delivery failed"] },
  );
});
