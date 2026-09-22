import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/locales/en.json";
import {
  searchSettings,
  SETTING_ENTRIES,
  SETTING_SECTIONS,
  settingTitleOf,
  type SettingSectionId,
} from "./settings-registry";

const messages = enMessages as Record<string, string>;
const sectionIds = new Set(SETTING_SECTIONS.map((s) => s.id));

describe("settings registry", () => {
  it("lists every category exactly once", () => {
    const expected: SettingSectionId[] = [
      "general",
      "dictation",
      "ai-processing",
      "pill-appearance",
      "shortcuts",
      "privacy-data",
      "updates",
      "advanced",
    ];
    expect(SETTING_SECTIONS.map((s) => s.id)).toEqual(expected);
  });

  it("resolves every section title from the catalog", () => {
    for (const section of SETTING_SECTIONS) {
      expect(
        messages[section.titleKey],
        `section ${section.id} title key ${section.titleKey}`,
      ).toBeTruthy();
    }
  });

  it("registers every setting exactly once against a catalog title", () => {
    const keys = SETTING_ENTRIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SETTING_ENTRIES) {
      expect(sectionIds.has(entry.section)).toBe(true);
      expect(messages[entry.key], `entry ${entry.key}`).toBeTruthy();
      for (const alias of entry.aliases) {
        expect(alias, `alias of ${entry.key}`).toBe(alias.toLowerCase());
      }
    }
  });

  it("matches titles, sections, and aliases case-insensitively", () => {
    expect(searchSettings("REVIEW").map((hit) => hit.entry.key)).toContain(
      "review_before_insert",
    );
    expect(searchSettings("beta").map((hit) => hit.entry.key)).toContain(
      "update_channel",
    );
    expect(searchSettings("pill").map((hit) => hit.entry.key)).toContain(
      "dictation_pill_visibility",
    );
    expect(searchSettings("   ")).toEqual([]);
  });

  it("returns titles from the catalog", () => {
    expect(settingTitleOf("review_before_insert")).toBe(
      messages["review_before_insert"],
    );
    expect(settingTitleOf("missing-key")).toBe("missing-key");
  });

  it("renders every registered setting exactly once on the settings page", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const page = readFileSync(
      resolve(here, "../components/settings/SettingsPage.tsx"),
      "utf8",
    );
    for (const entry of SETTING_ENTRIES) {
      const occurrences = page.split(`settingKey="${entry.key}"`).length - 1;
      expect(occurrences, `anchor for ${entry.key}`).toBe(1);
    }
  });
});
