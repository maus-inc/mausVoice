import { beforeEach, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  showError: vi.fn(),
  logger: { error: vi.fn(), verbose: vi.fn(), warning: vi.fn() },
}));
vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => ({
    getUserPreferences: mocks.get,
    setUserPreferences: mocks.set,
  }),
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("./app.actions", () => ({ showErrorSnackbar: mocks.showError }));
import { setPreferredMicrophone } from "./user-preferences.actions";
import { updateUserPreferences } from "./user-actions-core";

beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(null);
  mocks.set.mockImplementation(async (preferences: unknown) => preferences);
});

it.each(["load", "save"] as const)(
  "leaves %s failures for the microphone dialog to report once",
  async (stage) => {
    if (stage === "load")
      mocks.get.mockRejectedValueOnce(new Error("load failed"));
    else mocks.set.mockRejectedValueOnce(new Error("save failed"));
    await expect(setPreferredMicrophone("Mic")).rejects.toThrow();
    expect(mocks.showError).not.toHaveBeenCalled();
  },
);

it("still reports errors for other preference callers", async () => {
  mocks.set.mockRejectedValueOnce(new Error("save failed"));
  await expect(
    updateUserPreferences(() => {}, "Save failed"),
  ).rejects.toThrow();
  expect(mocks.showError).toHaveBeenCalledOnce();
});
