import { beforeEach, expect, it, vi } from "vitest";
import type { UserPreferences } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  get: vi.fn<() => Promise<UserPreferences | null>>(),
  save: vi.fn<(value: UserPreferences) => Promise<UserPreferences>>(),
  showError: vi.fn(),
}));
vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => ({
    getUserPreferences: mocks.get,
    setUserPreferences: mocks.save,
  }),
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: mocks.showError }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));
import {
  createDefaultPreferences,
  updateUserPreferences,
} from "./user-actions-core";

beforeEach(() => {
  vi.clearAllMocks();
  setAppState(
    {
      ...structuredClone(INITIAL_APP_STATE),
      userPrefs: createDefaultPreferences(),
    },
    true,
  );
  mocks.get.mockReset().mockResolvedValue(null);
  mocks.save.mockReset().mockImplementation(async (value) => value);
});

it("reconciles a committed write whose response failed before the next change", async () => {
  const original = createDefaultPreferences();
  const committed = { ...original, handsFreeDelayMs: 9000 };
  mocks.save.mockRejectedValueOnce(new Error("response lost"));
  mocks.get.mockResolvedValueOnce(committed);
  await expect(
    updateUserPreferences((p) => {
      p.handsFreeDelayMs = 9000;
    }),
  ).rejects.toThrow("response lost");
  expect(getAppState().userPrefs?.handsFreeDelayMs).toBe(9000);
  await updateUserPreferences((p) => {
    p.incognitoModeEnabled = true;
  });
  expect(mocks.save.mock.calls[1]![0]).toMatchObject({
    handsFreeDelayMs: 9000,
    incognitoModeEnabled: true,
  });
});

it("blocks later saves until a failed reconciliation can reload preferences", async () => {
  const original = createDefaultPreferences();
  mocks.save.mockRejectedValueOnce(new Error("response lost"));
  mocks.get.mockRejectedValueOnce(new Error("read failed"));
  await expect(
    updateUserPreferences((p) => {
      p.handsFreeDelayMs = 9000;
    }),
  ).rejects.toThrow("response lost");
  mocks.get.mockRejectedValueOnce(new Error("still unavailable"));
  await expect(
    updateUserPreferences((p) => {
      p.incognitoModeEnabled = true;
    }),
  ).rejects.toThrow("still unavailable");
  expect(mocks.save).toHaveBeenCalledTimes(1);
  mocks.get.mockResolvedValueOnce({ ...original, handsFreeDelayMs: 9000 });
  await updateUserPreferences((p) => {
    p.incognitoModeEnabled = true;
  });
  expect(mocks.save.mock.calls[1]![0]).toMatchObject({
    handsFreeDelayMs: 9000,
    incognitoModeEnabled: true,
  });
});
