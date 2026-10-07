// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_PAGES } from "../../utils/settings-registry";
import {
  getLastSettingsPage,
  rememberLastSettingsPage,
  resolveSettingsTarget,
  settingAnchorId,
  settingsPagePath,
} from "./settings-routes";

/**
 * The routes module is what makes one settings entry point serve every link
 * shape: the rail, `Cmd+,`, tips, and the old `?section=` links all arrive
 * here, and the answer decides which page and row a person lands on.
 */
describe("settings routes", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("names one page path per registry page", () => {
    for (const page of SETTINGS_PAGES) {
      expect(settingsPagePath(page.id)).toBe(`/dashboard/settings/${page.id}`);
    }
  });

  it("derives a row anchor from the setting key", () => {
    expect(settingAnchorId("hands_free_output_delay")).toBe(
      "setting-hands_free_output_delay",
    );
  });

  it("resolves a setting to the page that owns it", () => {
    const target = resolveSettingsTarget(
      { setting: "update_channel", section: null },
      {},
    );
    expect(target.page).toBe("system");
    expect(target.setting?.key).toBe("update_channel");
  });

  it("falls back to the page when the named setting is unavailable", () => {
    const target = resolveSettingsTarget(
      { setting: "pill_placement", section: null },
      { pill_placement: false },
    );
    expect(target.setting).toBeNull();
    expect(target.page).toBe(
      resolveSettingsTarget(
        { setting: null, section: null },
        { pill_placement: false },
      ).page,
    );
  });

  it("maps an old section link onto the page that inherited its rows", () => {
    expect(
      resolveSettingsTarget({ setting: null, section: "updates" }, {}).page,
    ).toBe("system");
    expect(
      resolveSettingsTarget({ setting: null, section: "ai-processing" }, {})
        .page,
    ).toBe("ai-models");
    expect(
      resolveSettingsTarget({ setting: null, section: "pill-appearance" }, {})
        .page,
    ).toBe("appearance");
  });

  it("reopens the last page visited, and the first page when there is none", () => {
    expect(
      resolveSettingsTarget({ setting: null, section: null }, {}).page,
    ).toBe("dictation");

    rememberLastSettingsPage("privacy-data");
    expect(getLastSettingsPage()).toBe("privacy-data");
    expect(
      resolveSettingsTarget({ setting: null, section: null }, {}).page,
    ).toBe("privacy-data");
  });

  it("ignores a stored page that no longer exists", () => {
    window.localStorage.setItem("maus-settings-last-page", "old-pill-page");
    expect(getLastSettingsPage()).toBeNull();
    expect(
      resolveSettingsTarget({ setting: null, section: null }, {}).page,
    ).toBe("dictation");
  });

  it("prefers an explicit setting over an old section link", () => {
    const target = resolveSettingsTarget(
      { setting: "hotkey_shortcuts", section: "updates" },
      {},
    );
    expect(target.page).toBe("shortcuts");
    expect(target.setting?.key).toBe("hotkey_shortcuts");
  });
});
