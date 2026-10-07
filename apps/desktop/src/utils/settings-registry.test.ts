import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enMessages from "../i18n/locales/en.json";
import { SETTINGS_PAGE_COPY } from "../components/settings/settings-page-copy";
import {
  DEFAULT_SETTINGS_PAGE,
  groupsForPage,
  isSettingAvailable,
  pageTitleOf,
  searchResultsByPage,
  searchSettings,
  SETTING_ENTRIES,
  SETTING_GROUPS,
  SETTINGS_PAGES,
  settingEntryOf,
  settingTitleOf,
  type SettingsPageId,
} from "./settings-registry";

const messages = enMessages as Record<string, string>;
const pageIds = new Set(SETTINGS_PAGES.map((page) => page.id));

const readSource = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

/**
 * Every file that can carry a `settingKey` anchor. The three standalone
 * components are here because they own rows their page renders, and leaving
 * them out would make the anchor assertions below silently incomplete.
 */
const SETTINGS_SOURCES = [
  ...SETTINGS_PAGES.map((page) => ({
    page: page.id,
    source: readSource(`../components/settings/pages/${pageFileOf(page.id)}`),
  })),
  {
    page: "appearance" as SettingsPageId,
    source: readSource("../components/settings/PillPlacementSetting.tsx"),
  },
  {
    page: "system" as SettingsPageId,
    source: readSource("../components/settings/UpdateSettingSection.tsx"),
  },
  {
    page: "system" as SettingsPageId,
    source: readSource("../components/settings/UpdateChannelSetting.tsx"),
  },
];

function pageFileOf(page: SettingsPageId): string {
  const pascal = page
    .split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return `${pascal}SettingsPage.tsx`;
}

/**
 * The registry is the single source of truth for the settings surface: it
 * drives the rail, search, and which rows exist at all. The tests below are
 * mostly behavioural, but two of them read the page source, because the one
 * thing behaviour cannot see is whether a registry entry is wired to a row in
 * the page that the entry names. A stale key there means a search hit for a
 * row that does not exist, or a row with no way to reach it by search.
 */
describe("settings registry", () => {
  it("lists the pages once each, in rail order, with catalog copy", () => {
    const ids = SETTINGS_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_SETTINGS_PAGE);
    for (const page of SETTINGS_PAGES) {
      expect(
        messages[page.titleKey],
        `page ${page.id} title key ${page.titleKey}`,
      ).toBeTruthy();
      expect(
        messages[page.descriptionKey],
        `page ${page.id} description key ${page.descriptionKey}`,
      ).toBeTruthy();
    }
  });

  it("keeps each page's copy keys pointing at the literals the page renders", () => {
    // The heading and intro are written as `FormattedMessage` literals in
    // `settings-page-copy.tsx`, and the registry stores the catalog keys the
    // rest of the surface reads (search, deep links). If the two drift, the
    // rail and search name a page one way and its own heading names it another.
    const defaultMessageOf = (node: unknown): string =>
      (node as { props: { defaultMessage?: string } }).props.defaultMessage ??
      "";
    for (const page of SETTINGS_PAGES) {
      const copy = SETTINGS_PAGE_COPY[page.id];
      expect(
        defaultMessageOf(copy.title),
        `page ${page.id} title literal`,
      ).toBe(messages[page.titleKey]);
      expect(
        defaultMessageOf(copy.description),
        `page ${page.id} description literal`,
      ).toBe(messages[page.descriptionKey]);
    }
  });

  it("declares group headings once per page and ties them to a page", () => {
    const seen = new Set<string>();
    for (const group of SETTING_GROUPS) {
      expect(pageIds.has(group.page), `group ${group.key} page`).toBe(true);
      expect(seen.has(`${group.page}/${group.key}`)).toBe(false);
      seen.add(`${group.page}/${group.key}`);
      expect(messages[group.key], `group ${group.key}`).toBeTruthy();
    }
  });

  it("registers every setting exactly once against a page and a group", () => {
    const keys = SETTING_ENTRIES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SETTING_ENTRIES) {
      expect(pageIds.has(entry.page), `entry ${entry.key} page`).toBe(true);
      expect(
        SETTING_GROUPS.some(
          (group) => group.page === entry.page && group.key === entry.group,
        ),
        `entry ${entry.key} group ${entry.group}`,
      ).toBe(true);
      expect(messages[entry.key], `entry title ${entry.key}`).toBeTruthy();
      for (const alias of entry.aliases) {
        expect(alias, `alias of ${entry.key}`).toBe(alias.toLowerCase());
      }
    }
  });

  it("wires every entry to exactly one row on the page it belongs to", () => {
    for (const entry of SETTING_ENTRIES) {
      const pageSource = SETTINGS_SOURCES.filter(
        (candidate) => candidate.page === entry.page,
      )
        .map((candidate) => candidate.source)
        .join("\n");
      const occurrences =
        pageSource.split(`settingKey="${entry.key}"`).length - 1;
      expect(occurrences, `anchor for ${entry.key}`).toBe(1);
    }
  });

  it("does not render a row that no registry entry backs", () => {
    const registered = new Set(SETTING_ENTRIES.map((entry) => entry.key));
    for (const { page, source } of SETTINGS_SOURCES) {
      const anchors = Array.from(
        source.matchAll(/settingKey="([a-z0-9_]+)"/g),
        (match) => match[1],
      );
      for (const anchor of anchors) {
        expect(registered.has(anchor), `${page} row ${anchor}`).toBe(true);
        expect(
          settingEntryOf(anchor)?.page,
          `${page} row ${anchor} belongs to its page`,
        ).toBe(page);
      }
    }
  });

  it("matches titles, page names, group names, and aliases case-insensitively", () => {
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
    expect(
      searchSettings("privacy and data").map((hit) => hit.entry.key),
    ).toContain("incognito_mode");
  });

  it("returns titles from the catalog and falls back to the key", () => {
    expect(settingTitleOf("review_before_insert")).toBe(
      messages["review_before_insert"],
    );
    expect(settingTitleOf("missing-key")).toBe("missing-key");
    expect(pageTitleOf("account")).toBe(messages["account"]);
  });

  it.each([
    "dictation_limit",
    "automatic_style_loading",
    "include_incognito_in_stats",
    "learn_from_corrections",
    "always_run_as_administrator",
    "elevenlabs_keyterms",
    "delete_account",
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

  it("treats a setting as available until something says otherwise", () => {
    expect(isSettingAvailable("microphone")).toBe(true);
    expect(isSettingAvailable("microphone", {})).toBe(true);
    expect(isSettingAvailable("microphone", { microphone: true })).toBe(true);
    expect(isSettingAvailable("microphone", { microphone: false })).toBe(false);
  });

  it("groups results by page in rail order", () => {
    const grouped = searchResultsByPage(searchSettings("input"));
    expect(grouped.map((group) => group.page.id)).toEqual(
      SETTINGS_PAGES.filter((page) =>
        grouped.some((group) => group.page.id === page.id),
      ).map((page) => page.id),
    );
    for (const group of grouped) {
      expect(group.hits.length).toBeGreaterThan(0);
      for (const hit of group.hits) {
        expect(hit.entry.page).toBe(group.page.id);
      }
    }
  });

  it("reports only groups whose rows survive the availability snapshot", () => {
    expect(groupsForPage("privacy-data")).toEqual([
      "what_leaves_your_device",
      "history_and_storage",
      "dictionary_learning",
      "devices",
    ]);
    expect(
      groupsForPage("privacy-data", {
        where_your_dictation_audio_goes: false,
        elevenlabs_keyterms: false,
      }),
    ).not.toContain("what_leaves_your_device");
    expect(
      groupsForPage("dictation", {
        microphone: false,
        audio: false,
      }),
    ).not.toContain("microphone_and_feedback");
    // Clearing local data is not gated on a session, so the row survives even
    // when the account rows cannot act.
    expect(groupsForPage("account", { delete_account: false })).toContain(
      "danger_zone",
    );
  });

  it("keeps clearing local data on the account page, not under privacy", () => {
    expect(settingEntryOf("clear_local_data")?.page).toBe("account");
    expect(groupsForPage("privacy-data")).not.toContain("danger_zone");
    expect(searchSettings("wipe").map((hit) => hit.entry.key)).toContain(
      "clear_local_data",
    );
  });

  it("searches and displays localized titles", () => {
    const localized = {
      microphone: "Mikrofon",
      dictation: "Diktat",
      microphone_and_feedback: "Mikrofon und Rückmeldung",
    };
    const [hit] = searchSettings("mikrofon", { messages: localized });
    expect(hit.entry.key).toBe("microphone");
    expect(hit.title).toBe("Mikrofon");
    expect(
      searchSettings("input device", { messages: localized })[0].title,
    ).toBe("Mikrofon");
    expect(
      searchSettings("diktat", { messages: localized }).map(
        (entry) => entry.entry.key,
      ),
    ).toContain("microphone");
  });

  it("indexes the provider key rows and the per-provider keyterms control", () => {
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
