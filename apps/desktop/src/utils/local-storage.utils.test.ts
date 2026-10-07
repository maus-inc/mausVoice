// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_MODE_STORAGE_KEY } from "../theme";
import {
  ACCOUNT_CREATED_AT_STORAGE_KEY,
  APP_DATA_STORAGE_KEYS,
  APP_DATA_STORAGE_PREFIXES,
  clearAppDataStorage,
  LAST_SETTINGS_PAGE_STORAGE_KEY,
  LEGACY_THEME_MODE_STORAGE_KEY,
  LOCAL_STATE_STORAGE_KEY,
  ONBOARDED_AT_STORAGE_KEY,
  PREVIEW_LOCAL_STATE_STORAGE_KEY,
  LEGACY_LOCAL_STATE_STORAGE_KEY,
  TOOL_ALWAYS_ALLOW_STORAGE_PREFIX,
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

  // Behaviour, not the shape of the list: every named key is set, then the wipe
  // runs, then each one is checked. Asserting the list against the same
  // constants it is built from would pass while an app-written key was missing
  // from it, which is how the theme key went unnoticed in the first place.
  it("removes every key the app names, whatever namespace they are in", () => {
    const themeKey = THEME_MODE_STORAGE_KEY;
    for (const key of [...APP_DATA_STORAGE_KEYS, themeKey]) {
      window.localStorage.setItem(key, "value");
    }

    clearAppDataStorage();

    for (const key of [...APP_DATA_STORAGE_KEYS, themeKey]) {
      expect(window.localStorage.getItem(key)).toBeNull();
    }
  });

  // The theme key is defined in `theme.ts`, which is the independent source: if
  // the two ever diverge, the wipe stops covering the appearance preference and
  // this is what says so.
  it("covers the theme mode the app writes through the theme provider", () => {
    expect(APP_DATA_STORAGE_KEYS).toContain(THEME_MODE_STORAGE_KEY);
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, "dark");
    window.localStorage.setItem(LEGACY_THEME_MODE_STORAGE_KEY, "dark");

    clearAppDataStorage();

    expect(window.localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBeNull();
    expect(
      window.localStorage.getItem(LEGACY_THEME_MODE_STORAGE_KEY),
    ).toBeNull();
  });

  it("removes keys named per item, which no fixed list can enumerate", () => {
    window.localStorage.setItem(
      `${TOOL_ALWAYS_ALLOW_STORAGE_PREFIX}global:read_file`,
      "true",
    );
    window.localStorage.setItem(
      "mausvoice.pending-transcription-deletes",
      "[]",
    );
    window.localStorage.setItem("mausvoice:checklist-dismissed", "true");

    clearAppDataStorage();

    expect(
      window.localStorage.getItem(
        `${TOOL_ALWAYS_ALLOW_STORAGE_PREFIX}global:read_file`,
      ),
    ).toBeNull();
    expect(
      window.localStorage.getItem("mausvoice.pending-transcription-deletes"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("mausvoice:checklist-dismissed"),
    ).toBeNull();
  });

  // The legacy names are history, not choices: someone who upgraded still has
  // state under them, so the exact strings are pinned rather than trusted, and
  // the wipe is checked against the strings themselves.
  it("removes state written under the names this app used before", () => {
    expect(LEGACY_LOCAL_STATE_STORAGE_KEY).toBe("voquill-local-state");
    expect(PREVIEW_LOCAL_STATE_STORAGE_KEY).toBe(
      "mausvoice-browser-preview-local-state",
    );
    window.localStorage.setItem("voquill-local-state", "{}");
    window.localStorage.setItem("mausvoice-browser-preview-local-state", "{}");
    window.localStorage.setItem("voquill-pending-deletes", "[]");

    clearAppDataStorage();

    expect(window.localStorage.getItem("voquill-local-state")).toBeNull();
    expect(
      window.localStorage.getItem("mausvoice-browser-preview-local-state"),
    ).toBeNull();
    expect(window.localStorage.getItem("voquill-pending-deletes")).toBeNull();
  });

  // A prefix is a blunt instrument, so its breadth is the risk: one that covered
  // the auth session would turn a wipe into a sign-out. Firebase's namespace is
  // the one thing here that must stay outside every prefix the app owns.
  it("owns no namespace wide enough to hold the auth session", () => {
    const sessionKey = "firebase:authUser:key:[DEFAULT]";

    for (const prefix of APP_DATA_STORAGE_PREFIXES) {
      expect(prefix.length).toBeGreaterThan(0);
      expect(sessionKey.startsWith(prefix)).toBe(false);
    }
  });

  it("reports the keys the browser refused to remove", () => {
    window.localStorage.setItem(LOCAL_STATE_STORAGE_KEY, "{}");
    window.localStorage.setItem(ACCOUNT_CREATED_AT_STORAGE_KEY, "2026-01-01");
    const removeItem = window.localStorage.removeItem.bind(window.localStorage);
    const spy = vi
      .spyOn(window.localStorage, "removeItem")
      .mockImplementation((key: string) => {
        if (key === LOCAL_STATE_STORAGE_KEY) {
          throw new Error("storage is read-only");
        }
        removeItem(key);
      });

    expect(clearAppDataStorage()).toEqual([LOCAL_STATE_STORAGE_KEY]);

    spy.mockRestore();
    // One refusal does not abandon the rest of the wipe.
    expect(
      window.localStorage.getItem(ACCOUNT_CREATED_AT_STORAGE_KEY),
    ).toBeNull();
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

    clearAppDataStorage();

    expect(window.localStorage.getItem(LOCAL_STATE_STORAGE_KEY)).toBeNull();
  });

  // The one thing a wipe must not take with it. The session keys are on a
  // different origin namespace, and this is what keeps a broadened wipe from
  // signing the person out.
  it("leaves a key this app never wrote alone", () => {
    window.localStorage.setItem("some-other-app:preference", "keep");

    clearAppDataStorage();

    expect(window.localStorage.getItem("some-other-app:preference")).toBe(
      "keep",
    );
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
