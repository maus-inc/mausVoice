import { readFileSync } from "node:fs";
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
const sectionIds = new Set(SETTING_SECTIONS.map((section) => section.id));
const pageSource = readFileSync(
  new URL("../components/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

/**
 * The registry is the single source of truth for the settings page: it drives
 * search, it decides which sections exist, and the rail is built from it.
 *
 * Most of what follows is behavioural — it calls the exported functions and
 * asserts on what they return. That matters because the page and the rail read
 * this registry rather than restating it, so an assertion about the source text
 * of `SettingsPage.tsx` cannot see a section that exists in the registry and
 * nowhere else, or a title that resolves to a key instead of a label. The two
 * source-text assertions that remain are about the page's own anchors, which is
 * the one thing the rendered tests cannot reach.
 */
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
    expect(SETTING_SECTIONS.map((section) => section.id)).toEqual(expected);
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
    const keys = SETTING_ENTRIES.map((entry) => entry.key);
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
    for (const entry of SETTING_ENTRIES) {
      const occurrences =
        pageSource.split(`settingKey="${entry.key}"`).length - 1;
      expect(occurrences, `anchor for ${entry.key}`).toBe(1);
    }
  });

  it("routes monitor labels and its accessible name through message descriptors", () => {
    for (const message of [
      "Current monitor",
      "Cursor monitor",
      "Reset pill position monitor",
    ]) {
      expect(pageSource).toContain(`defaultMessage: "${message}"`);
    }
    expect(pageSource).not.toContain('ariaLabel="Reset pill position monitor"');
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
    const localized = { microphone: "Mikrofon", general: "Allgemein" };
    expect(searchSettings("mikrofon", { messages: localized })).toContainEqual({
      entry: SETTING_ENTRIES.find((entry) => entry.key === "microphone"),
      title: "Mikrofon",
      sectionTitle: "Allgemein",
    });
    expect(
      searchSettings("allgemein", { messages: localized }).map(
        (hit) => hit.entry.key,
      ),
    ).toContain("microphone");
    expect(
      searchSettings("input device", { messages: localized })[0].title,
    ).toBe("Mikrofon");
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

/**
 * The page's section wrappers.
 *
 * These assert on the page source because the rendered assertion belongs to
 * `SettingsSectionScroll.test.tsx`, which mounts the page; what is checked here
 * is the narrower claim that each wrapper takes its id from `sectionAnchorId`
 * rather than restating the string. A hand-written `id="section-general"` can
 * drift from the helper the rail scrolls with and leave a button that scrolls
 * nowhere, and the rendered test cannot tell the two spellings apart because
 * both produce the same DOM.
 */
describe("settings section anchors", () => {
  it.each(SETTING_SECTIONS.map((entry) => [entry.id]))(
    "derives the section-%s wrapper id from sectionAnchorId",
    (id) => {
      expect(pageSource).toContain(`id={sectionAnchorId("${id}")}`);
    },
  );

  it("renders exactly one wrapper per registry section", () => {
    const anchors =
      pageSource.match(/id=\{sectionAnchorId\("[a-z-]+"\)\}/g) ?? [];
    expect(anchors).toHaveLength(SETTING_SECTIONS.length);
  });

  it("renders the sections in registry order, so the rail order matches the page", () => {
    const order = Array.from(
      pageSource.matchAll(/id=\{sectionAnchorId\("([a-z-]+)"\)\}/g),
    ).map((match) => match[1]);
    expect(order).toEqual(SETTING_SECTIONS.map((entry) => entry.id));
  });

  it("does not hand-write a section id the helper already owns", () => {
    // The literal form is what the drift looks like. Excluding the helper's own
    // definition, a bare `id="section-..."` means the page and the rail can
    // disagree about the id with no compile error.
    const handWritten = Array.from(
      pageSource.matchAll(/id="(section-[a-z-]+)"/g),
    ).map((match) => match[1]);
    expect(handWritten).toEqual([]);
  });

  it("mounts the navigation rail on the settings page", () => {
    expect(pageSource).toContain("<SettingsSectionNav");
  });

  it("keeps the rail out of the search-results view", () => {
    // The rail scrolls to sections the search view replaces, so showing both at
    // once would leave a visible control that does nothing.
    const conditional = pageSource.slice(
      pageSource.indexOf("query.trim() ?"),
      pageSource.indexOf("<SettingsSectionNav"),
    );
    expect(conditional).not.toContain("SettingsSectionNav");
  });
});
