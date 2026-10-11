// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("./log.utils", () => ({ getLogger: () => loggerMock }));

import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";
import { LOCAL_STATE_STORAGE_KEY } from "./local-storage.utils";
import { clearLocalData } from "./local-data.utils";

/**
 * Two flows promise to remove this device's copy of the app's data — "Clear
 * local data" and deleting the account — and the account flow used to run only
 * the native half. The photo someone set for their account is a data URL in
 * localStorage, outside the database the native wipe empties, so it survived a
 * deletion that promised to erase it. What this seam owes its callers is that
 * both halves always run and that the leftover keys are reported rather than
 * thrown.
 */
describe("clearLocalData", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    loggerMock.info.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  const seedProfileImage = () =>
    setAppState((state) => ({
      ...state,
      local: {
        ...state.local,
        profileImageByUserId: { "user-1": "data:image/png;base64,AAAA" },
      },
    }));

  it("stops the recorder and the key listener before wiping", async () => {
    await clearLocalData();

    const commands = invokeMock.mock.calls.map(([command]) => command);
    // Presence first: an absent command would otherwise compare as "before"
    // anything and pass an ordering-only assertion.
    expect(commands).toContain("stop_key_listener");
    expect(commands).toContain("stop_recording");
    expect(commands.indexOf("stop_key_listener")).toBeLessThan(
      commands.indexOf("clear_local_data"),
    );
    expect(commands.indexOf("stop_recording")).toBeLessThan(
      commands.indexOf("clear_local_data"),
    );
  });

  it("wipes anyway when a stop command fails", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "stop_recording"
        ? Promise.reject(new Error("no session"))
        : Promise.resolve(undefined),
    );

    await expect(clearLocalData()).resolves.toEqual({ storageFailedKeys: [] });

    expect(invokeMock).toHaveBeenCalledWith("clear_local_data");
  });

  it("empties the stored data and the in-memory slice together", async () => {
    seedProfileImage();
    window.localStorage.setItem(LOCAL_STATE_STORAGE_KEY, "{}");

    const wipe = await clearLocalData();

    expect(wipe.storageFailedKeys).toEqual([]);
    expect(window.localStorage.getItem(LOCAL_STATE_STORAGE_KEY)).toBeNull();
    expect(getAppState().local).toEqual(INITIAL_APP_STATE.local);
  });

  it("resets the slice before storage is cleared, so nothing is written back", async () => {
    // Ordering is the whole point of resetting the slice first: the persist
    // middleware rewrites its key on the next state change, so a slice still
    // holding the photo would put it straight back out after the storage wipe.
    // The state change below stands in for whatever the app does next.
    seedProfileImage();

    await clearLocalData();
    produceAppState((draft) => {
      draft.local.disablePillRewards = true;
    });

    const persisted =
      window.localStorage.getItem(LOCAL_STATE_STORAGE_KEY) ?? "";
    expect(persisted).not.toContain("data:image/png");
    expect(getAppState().local.profileImageByUserId).toEqual({});
  });

  it("reports the keys a blocked browser would not remove", async () => {
    window.localStorage.setItem(LOCAL_STATE_STORAGE_KEY, "{}");
    const removeItem = vi
      .spyOn(window.localStorage, "removeItem")
      .mockImplementation((key: string) => {
        if (key === LOCAL_STATE_STORAGE_KEY) {
          throw new Error("quota");
        }
      });

    try {
      const wipe = await clearLocalData();

      expect(wipe.storageFailedKeys).toEqual([LOCAL_STATE_STORAGE_KEY]);
    } finally {
      removeItem.mockRestore();
    }
  });
});
