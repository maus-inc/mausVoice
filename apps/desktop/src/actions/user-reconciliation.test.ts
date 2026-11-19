import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@maus-inc/types";
import { seedManualStyles } from "../../test/helpers/tone-test.utils";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";

const repos = vi.hoisted(() => ({
  save: vi.fn<(user: User) => Promise<User>>(),
  load: vi.fn<() => Promise<User | null>>(),
  toast: vi.fn(),
}));
vi.mock("../repos", () => ({
  getUserRepo: () => ({ setMyUser: repos.save, getMyUser: repos.load }),
  getUserPreferencesRepo: () => ({}),
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: repos.toast }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));
import { setPreferredLanguage, setUserName } from "./user.actions";

beforeEach(() => {
  vi.clearAllMocks();
  seedManualStyles("default");
  repos.save.mockImplementation(async (user) => user);
  repos.load.mockResolvedValue(null);
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

it("withdraws an unconfirmed profile and reconciles before a later edit", async () => {
  const original = structuredClone(getAppState().userById[LOCAL_USER_ID]!);
  let reject!: (error: Error) => void;
  repos.save.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  repos.load.mockRejectedValueOnce(new Error("read failed"));
  const first = setPreferredLanguage("fr");
  await Promise.resolve();
  expect(getAppState().userById[LOCAL_USER_ID]?.preferredLanguage).toBe("fr");
  reject(new Error("write response failed"));
  await expect(first).rejects.toThrow("write response failed");
  expect(getAppState().userById[LOCAL_USER_ID]?.preferredLanguage).toBe(
    original.preferredLanguage,
  );

  repos.load.mockRejectedValueOnce(new Error("still unavailable"));
  await expect(setUserName("Renamed")).rejects.toThrow("still unavailable");
  expect(repos.save).toHaveBeenCalledTimes(1);

  // The failed call actually committed before its response was lost.
  repos.load.mockResolvedValueOnce({ ...original, preferredLanguage: "fr" });
  await setUserName("Renamed");
  expect(repos.save).toHaveBeenCalledTimes(2);
  expect(repos.save.mock.calls[1][0]).toMatchObject({
    name: "Renamed",
    preferredLanguage: "fr",
  });
});

it("does not roll back a newer user state when recovery fails", async () => {
  const original = structuredClone(getAppState().userById[LOCAL_USER_ID]!);
  let reject!: (error: Error) => void;
  repos.save.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  repos.load.mockRejectedValueOnce(new Error("read failed"));
  const first = setPreferredLanguage("fr");
  await Promise.resolve();
  produceAppState((draft) => {
    draft.userById[LOCAL_USER_ID]!.bio = "Newer state";
  });
  reject(new Error("write failed"));
  await expect(first).rejects.toThrow("write failed");
  expect(getAppState().userById[LOCAL_USER_ID]?.bio).toBe("Newer state");
  repos.load.mockResolvedValueOnce(original);
  await setUserName("Renamed");
});

it("lets an inline caller suppress the toast without changing the default", async () => {
  const original = structuredClone(getAppState().userById[LOCAL_USER_ID]!);
  repos.load.mockResolvedValue(original);
  repos.save.mockRejectedValueOnce(new Error("write failed"));
  await expect(
    setPreferredLanguage("fr", undefined, { showErrorToast: false }),
  ).rejects.toThrow("write failed");
  expect(repos.toast).not.toHaveBeenCalled();
  repos.save.mockRejectedValueOnce(new Error("write failed again"));
  await expect(setPreferredLanguage("fr")).rejects.toThrow(
    "write failed again",
  );
  expect(repos.toast).toHaveBeenCalledTimes(1);
});

it("rejects a language update when there is no user to save", async () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  await expect(setPreferredLanguage("fr")).rejects.toThrow("User not found");
  expect(repos.save).not.toHaveBeenCalled();
});
