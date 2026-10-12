import {
  DEFAULT_SETTINGS_PAGE,
  isSettingsPageId,
  settingEntryOf,
  type SettingAvailability,
  type SettingEntry,
  type SettingsPageId,
} from "../../utils/settings-registry";
import {
  getLocalStorageString,
  LAST_SETTINGS_PAGE_STORAGE_KEY,
  setLocalStorageString,
} from "../../utils/local-storage.utils";

export const SETTINGS_BASE_PATH = "/dashboard/settings";

/** DOM id of one setting row, and the hash the rail and search link to. */
export const settingAnchorId = (key: string): string => `setting-${key}`;

export const settingsPagePath = (page: SettingsPageId): string =>
  `${SETTINGS_BASE_PATH}/${page}`;

/**
 * Old `?section=` deep links, from when the whole surface was one page. Each
 * old section maps to the page that inherited most of its rows, so a stored
 * link still lands somewhere useful instead of dropping to the default page.
 */
const LEGACY_SECTION_PAGES: Record<string, SettingsPageId> = {
  general: "dictation",
  dictation: "dictation",
  "ai-processing": "ai-models",
  "pill-appearance": "appearance",
  shortcuts: "shortcuts",
  "privacy-data": "privacy-data",
  updates: "system",
  advanced: "system",
};

export type SettingsTarget = {
  page: SettingsPageId;
  /** Setting to land on, when the link named one that is available. */
  setting: SettingEntry | null;
};

/**
 * Where a settings link should land, whatever form it arrives in.
 *
 * `?setting=<key>` is the precise form used by tips and error recovery, and it
 * resolves to that row's page. `?section=<id>` is the older form. Anything else,
 * including an unknown or unavailable setting, falls back to the last page the
 * person opened, then to the default page.
 */
export const resolveSettingsTarget = (
  params: { setting: string | null; section: string | null },
  availability?: SettingAvailability,
): SettingsTarget => {
  const entry = params.setting ? settingEntryOf(params.setting) : undefined;
  if (entry && availability?.[entry.key] !== false) {
    return { page: entry.page, setting: entry };
  }

  const legacyPage = params.section
    ? LEGACY_SECTION_PAGES[params.section]
    : undefined;
  return {
    page: legacyPage ?? getLastSettingsPage() ?? DEFAULT_SETTINGS_PAGE,
    setting: null,
  };
};

/**
 * Remember the page someone was last on, so `Cmd+,` and the rail's Settings
 * entry reopen where they left off instead of always resetting to the first
 * page. Stored as a plain string and validated on read: an unknown page from an
 * older build reads as unset rather than as a 404.
 */
export const rememberLastSettingsPage = (page: SettingsPageId): void => {
  setLocalStorageString(LAST_SETTINGS_PAGE_STORAGE_KEY, page);
};

export const getLastSettingsPage = (): SettingsPageId | null => {
  const stored = getLocalStorageString(LAST_SETTINGS_PAGE_STORAGE_KEY);
  return stored && isSettingsPageId(stored) ? stored : null;
};
