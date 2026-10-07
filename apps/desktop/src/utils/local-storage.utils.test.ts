// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_CREATED_AT_STORAGE_KEY,
  APP_DATA_STORAGE_KEYS,
  clearAppDataStorage,
  LAST_SETTINGS_PAGE_STORAGE_KEY,
  LOCAL_STATE_STORAGE_KEY,
  ONBOARDED_AT_STORAGE_KEY,
  PREVIEW_LOCAL_STATE_STORAGE_KEY,
  LEGACY_LOCAL_STATE_STORAGE_KEY,
} from "./local-storage.utils";

/**
 * "Clear local data" promises to remove what this app knows about you on this
 * device. The database and the managed audio directory are wiped by the Rust
 * command; these keys live outside both, so the list and the wipe are pinned
 * here.
 */
describe("clearAppDataStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("covers every key the app writes", () => {
    expect([...APP_DATA_STORAGE_KEYS].sort()).toEqual(
      [
        LOCAL_STATE_STORAGE_KEY,
        PREVIEW_LOCAL_STATE_STORAGE_KEY,
        LEGACY_LOCAL_STATE_STORAGE_KEY,
        ACCOUNT_CREATED_AT_STORAGE_KEY,
        ONBOARDED_AT_STORAGE_KEY,
        LAST_SETTINGS_PAGE_STORAGE_KEY,
      ].sort(),
    );
  });

  it("removes the persisted local slice, including the profile photo", () => {
    window.localStorage.setItem(
      LOCAL_STATE_STORAGE_KEY,
      JSON.stringify({
        state: {
          local: { profileImageByUserId: { "user-1": "data:image/png" } },
        },
      }),
    );
    window.localStorage.setItem("mui-mode", "dark");

    clearAppDataStorage();

    expect(window.localStorage.getItem(LOCAL_STATE_STORAGE_KEY)).toBeNull();
    // A key this app does not own, so nothing here can be mistaken for a
    // blanket localStorage wipe.
    expect(window.localStorage.getItem("mui-mode")).toBe("dark");
  });

  it("removes the account anchors and the remembered settings page", () => {
    window.localStorage.setItem(ACCOUNT_CREATED_AT_STORAGE_KEY, "2026-01-01");
    window.localStorage.setItem(ONBOARDED_AT_STORAGE_KEY, "2026-01-02");
    window.localStorage.setItem(LAST_SETTINGS_PAGE_STORAGE_KEY, "account");

    clearAppDataStorage();

    expect(
      window.localStorage.getItem(ACCOUNT_CREATED_AT_STORAGE_KEY),
    ).toBeNull();
    expect(window.localStorage.getItem(ONBOARDED_AT_STORAGE_KEY)).toBeNull();
    expect(
      window.localStorage.getItem(LAST_SETTINGS_PAGE_STORAGE_KEY),
    ).toBeNull();
  });

  it("leaves the signed-in session alone, because this is not a sign-out", () => {
    const sessionKey = "firebase:authUser:key:[DEFAULT]";
    window.localStorage.setItem(sessionKey, "{}");

    clearAppDataStorage();

    expect(window.localStorage.getItem(sessionKey)).toBe("{}");
  });
});
