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

  it("declares every registered setting anchor exactly once on the settings page", () => {
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
  it("routes monitor labels and its accessible name through message descriptors", () => {
    const page = readFileSync(
      new URL("../components/settings/SettingsPage.tsx", import.meta.url),
      "utf8",
    );
    for (const message of [
      "Current monitor",
      "Cursor monitor",
      "Reset pill position monitor",
    ]) {
      expect(page).toContain(`defaultMessage: "${message}"`);
    }
    expect(page).not.toContain('ariaLabel="Reset pill position monitor"');
  });
  it.each([
    "dictation_limit_minutes",
    "automatic_style_loading",
    "styling_mode",
    "include_incognito_in_stats",
    "learn_from_corrections",
    "always_run_as_administrator",
  ])("omits unavailable %s without removing other matches", (key) => {
    const query = settingTitleOf(key);
    expect(searchSettings(query).map((hit) => hit.entry.key)).toContain(key);
    expect(
      searchSettings(query, { availability: { [key]: false } }).map(
        (hit) => hit.entry.key,
      ),
    ).not.toContain(key);
    expect(
      searchSettings(query, { availability: { [key]: true } }).map(
        (hit) => hit.entry.key,
      ),
    ).toContain(key);
  });
  it("searches and displays localized setting and section titles", () => {
    const messages = { microphone: "Mikrofon", general: "Allgemein" };
    expect(searchSettings("mikrofon", { messages })).toContainEqual({
      entry: SETTING_ENTRIES.find((entry) => entry.key === "microphone"),
      title: "Mikrofon",
      sectionTitle: "Allgemein",
    });
    expect(
      searchSettings("allgemein", { messages }).map((hit) => hit.entry.key),
    ).toContain("microphone");
    expect(searchSettings("input device", { messages })[0].title).toBe(
      "Mikrofon",
    );
  });
  it("indexes the failure-audio and provider-specific keyterm controls", () => {
    expect(searchSettings("snapshot").map((hit) => hit.entry.key)).toContain(
      "preserve_audio_on_failure",
    );
    expect(searchSettings("keyterms").map((hit) => hit.entry.key)).toContain(
      "elevenlabs_keyterms",
    );
    expect(
      searchSettings("keyterms", {
        availability: { elevenlabs_keyterms: false },
      }),
    ).toEqual([]);
  });
});
