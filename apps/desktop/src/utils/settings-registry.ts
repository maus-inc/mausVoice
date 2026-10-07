import enMessages from "../i18n/locales/en.json";

/**
 * One page per section of the settings surface. Each page is a route
 * (`/dashboard/settings/<id>`), owns a short list of groups, and is short
 * enough to scan without a scroll spy.
 *
 * `titleKey` and `descriptionKey` are en.json keys rather than strings:
 * the page headings are written as `FormattedMessage` literals in
 * `SettingsPageHeader`, so extraction creates the keys, and this registry
 * reads the same catalog the rest of the app renders from. A key that no
 * longer matches a literal fails `settings-registry.test.ts`.
 */
export type SettingsPageId =
  | "dictation"
  | "ai-models"
  | "shortcuts"
  | "appearance"
  | "privacy-data"
  | "system"
  | "account";

export type SettingsPageMeta = {
  id: SettingsPageId;
  titleKey: string;
  descriptionKey: string;
};

export const SETTINGS_PAGES: SettingsPageMeta[] = [
  {
    id: "dictation",
    titleKey: "dictation",
    descriptionKey:
      "how_mausvoice_listens_and_what_it_does_with_the_words_it_hea",
  },
  {
    id: "ai-models",
    titleKey: "ai_and_models",
    descriptionKey:
      "which_models_transcribe_your_speech_and_which_provider_polis",
  },
  {
    id: "shortcuts",
    titleKey: "shortcuts",
    descriptionKey:
      "the_keys_that_start_dictation_and_the_keys_that_switch_style",
  },
  {
    id: "appearance",
    titleKey: "appearance",
    descriptionKey:
      "how_the_pill_the_menu_bar_icon_and_celebrations_look_and_beh",
  },
  {
    id: "privacy-data",
    titleKey: "privacy_and_data",
    descriptionKey:
      "what_stays_on_this_computer_what_leaves_it_and_how_to_remove",
  },
  {
    id: "system",
    titleKey: "system",
    descriptionKey: "startup_input_permissions_updates_diagnostics_and_legal",
  },
  {
    id: "account",
    titleKey: "account",
    descriptionKey: "your_profile_your_sign_in_and_your_account",
  },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = "dictation";

export const settingsPageOf = (id: string): SettingsPageMeta | undefined =>
  SETTINGS_PAGES.find((page) => page.id === id);

export const isSettingsPageId = (value: string): value is SettingsPageId =>
  SETTINGS_PAGES.some((page) => page.id === value);

/**
 * Group headings inside a page, in page order. Every entry below names one of
 * these keys, and the page components carry the matching literal, so a group
 * cannot be declared here and rendered nowhere.
 */
export type SettingGroupMeta = {
  key: string;
  page: SettingsPageId;
};

export const SETTING_GROUPS: SettingGroupMeta[] = [
  { key: "microphone_and_feedback", page: "dictation" },
  { key: "language", page: "dictation" },
  { key: "while_you_dictate", page: "dictation" },
  { key: "output", page: "dictation" },

  { key: "transcription", page: "ai-models" },
  { key: "post_processing", page: "ai-models" },
  { key: "assistant", page: "ai-models" },
  { key: "styles", page: "ai-models" },

  { key: "dictation", page: "shortcuts" },
  { key: "styles", page: "shortcuts" },

  { key: "pill", page: "appearance" },
  { key: "menu_bar", page: "appearance" },
  { key: "celebrations", page: "appearance" },

  { key: "what_leaves_your_device", page: "privacy-data" },
  { key: "history_and_storage", page: "privacy-data" },
  { key: "dictionary_learning", page: "privacy-data" },
  { key: "devices", page: "privacy-data" },

  { key: "startup", page: "system" },
  { key: "input_permissions", page: "system" },
  { key: "updates", page: "system" },
  { key: "support", page: "system" },
  { key: "legal", page: "system" },

  { key: "profile", page: "account" },
  { key: "security", page: "account" },
  { key: "danger_zone", page: "account" },
];

export type SettingEntry = {
  /** en.json key: the single source of the row title. */
  key: string;
  page: SettingsPageId;
  /** en.json key of the group heading this row renders under. */
  group: string;
  /** Lowercase synonyms the title alone would miss. */
  aliases: string[];
};

const settingsForGroup = (
  page: SettingsPageId,
  group: string,
  aliasesByKey: Record<string, string[]>,
): SettingEntry[] =>
  Object.entries(aliasesByKey).map(([key, aliases]) => ({
    key,
    page,
    group,
    aliases,
  }));

export const SETTING_ENTRIES: SettingEntry[] = [
  ...settingsForGroup("dictation", "microphone_and_feedback", {
    microphone: ["mic", "input device", "capture"],
    audio: ["sound", "speaker", "volume", "chime"],
  }),
  ...settingsForGroup("dictation", "language", {
    dictation_language: ["language", "locale", "multilingual"],
    multiple_languages: ["multilingual", "language hotkeys", "switch language"],
  }),
  ...settingsForGroup("dictation", "while_you_dictate", {
    spoken_commands: ["voice commands", "new line", "punctuation"],
    silence_hallucination_filter: ["hallucination", "noise", "filter"],
    switch_style_while_dictating: ["cycle styles", "arrow keys"],
  }),
  ...settingsForGroup("dictation", "output", {
    text_insertion_options: ["paste", "typing", "insert", "apps"],
    real_time_output: ["realtime", "streaming", "live"],
    review_before_insert: ["review", "composer", "approve"],
    dictation_limit: ["max length", "timeout", "limit"],
    hands_free_output_delay: ["delay", "handsfree", "wait"],
  }),

  ...settingsForGroup("ai-models", "transcription", {
    deepgram_api_key: ["deepgram", "streaming", "api key"],
    ai_transcription: ["stt", "speech to text", "model", "local"],
  }),
  ...settingsForGroup("ai-models", "post_processing", {
    groq_api_key: ["groq", "llm", "api key"],
    ai_post_processing: ["polish", "cleanup", "llm"],
  }),
  ...settingsForGroup("ai-models", "assistant", {
    assistant_mode: ["agent", "chat", "assistant"],
  }),
  ...settingsForGroup("ai-models", "styles", {
    styling_mode: ["app styles", "manual styles"],
    automatic_style_loading: ["auto load style"],
  }),

  ...settingsForGroup("shortcuts", "dictation", {
    hotkey_shortcuts: ["hotkey", "keyboard", "keybind"],
  }),
  ...settingsForGroup("shortcuts", "styles", {
    style_hotkeys: ["style keys"],
  }),

  ...settingsForGroup("appearance", "pill", {
    dictation_pill_visibility: ["pill", "show pill", "hide pill"],
    pill_placement: ["pill position", "top", "bottom", "anchor"],
    reset_pill_position: ["pill monitor", "move pill"],
  }),
  ...settingsForGroup("appearance", "menu_bar", {
    show_menu_bar_icon: ["tray", "menu bar", "taskbar"],
  }),
  ...settingsForGroup("appearance", "celebrations", {
    streak_celebrations: ["flame", "fireworks", "rewards"],
  }),

  ...settingsForGroup("privacy-data", "what_leaves_your_device", {
    where_your_dictation_audio_goes: [
      "audio",
      "audio sent",
      "microphone upload",
      "provider",
      "recording upload",
      "streaming",
    ],
    elevenlabs_keyterms: ["keyterms", "surcharge", "elevenlabs"],
  }),
  ...settingsForGroup("privacy-data", "history_and_storage", {
    incognito_mode: ["private", "incognito", "no history"],
    include_incognito_in_stats: ["stats", "usage"],
    preserve_audio_on_failure: ["failed audio", "replay", "snapshot"],
  }),
  ...settingsForGroup("privacy-data", "dictionary_learning", {
    auto_learn_dictionary: ["autolearn", "dictionary", "corrections"],
    learn_from_corrections: ["watch edits"],
  }),
  ...settingsForGroup("privacy-data", "devices", {
    multi_device: ["pair", "remote", "phone"],
  }),
  ...settingsForGroup("system", "startup", {
    start_on_system_startup: ["autostart", "launch", "boot"],
    always_run_as_administrator: ["admin", "elevated", "uac"],
  }),
  ...settingsForGroup("system", "input_permissions", {
    configure_input_permissions: ["setup permissions", "uinput", "udev"],
  }),
  ...settingsForGroup("system", "updates", {
    software_update: ["check for updates", "version", "check now"],
    automatically_show_updates: ["auto update", "update popup"],
    update_channel: ["beta", "stable", "prerelease", "channel"],
  }),
  ...settingsForGroup("system", "support", {
    diagnostics: ["debug", "logs", "troubleshoot"],
  }),
  ...settingsForGroup("system", "legal", {
    terms_conditions: ["licence", "license", "legal"],
  }),

  ...settingsForGroup("account", "profile", {
    name: ["profile", "username", "display name"],
    signed_in_as: ["email", "signed in"],
    plan: ["subscription", "billing", "pro", "free"],
  }),
  ...settingsForGroup("account", "security", {
    change_password: ["password", "reset"],
    sign_out: ["log out", "logout", "sign out"],
  }),
  ...settingsForGroup("account", "danger_zone", {
    clear_local_data: [
      "danger zone",
      "delete data",
      "reset",
      "wipe",
      "history",
    ],
    delete_account: ["remove account", "close account"],
  }),
];

export type SettingHit = {
  entry: SettingEntry;
  title: string;
  pageTitle: string;
  groupTitle: string;
};

export type SettingAvailability = Readonly<Partial<Record<string, boolean>>>;
export type SettingsSearchOptions = {
  availability?: SettingAvailability;
  messages?: Readonly<Record<string, unknown>>;
};

const englishMessages = enMessages as Record<string, string>;

export const settingTitleOf = (
  key: string,
  messages?: SettingsSearchOptions["messages"],
): string => {
  const localized = messages?.[key];
  return typeof localized === "string"
    ? localized
    : (englishMessages[key] ?? key);
};

const pageMetaOf = (page: SettingsPageId): SettingsPageMeta | undefined =>
  SETTINGS_PAGES.find((entry) => entry.id === page);

export const pageTitleOf = (
  page: SettingsPageId,
  messages?: SettingsSearchOptions["messages"],
): string => {
  const meta = pageMetaOf(page);
  return meta ? settingTitleOf(meta.titleKey, messages) : page;
};

export const groupTitleOf = (
  group: string,
  messages?: SettingsSearchOptions["messages"],
): string => settingTitleOf(group, messages);

export const settingEntryOf = (key: string): SettingEntry | undefined =>
  SETTING_ENTRIES.find((entry) => entry.key === key);

/** Groups for one page, in page order, that have at least one visible row. */
export const groupsForPage = (
  page: SettingsPageId,
  availability?: SettingAvailability,
): string[] => {
  const visible = SETTING_ENTRIES.filter(
    (entry) =>
      entry.page === page && isSettingAvailable(entry.key, availability),
  );
  return SETTING_GROUPS.filter((group) => group.page === page)
    .map((group) => group.key)
    .filter((key) => visible.some((entry) => entry.group === key));
};

export const isSettingAvailable = (
  key: string,
  availability?: SettingAvailability,
): boolean => availability?.[key] !== false;

/**
 * Match available controls using localized titles and shared search aliases.
 * Availability is consulted here as well as on the pages, so search can never
 * offer a row the current platform does not render.
 */
export const searchSettings = (
  query: string,
  { availability, messages }: SettingsSearchOptions = {},
): SettingHit[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SETTING_ENTRIES.filter((entry) =>
    isSettingAvailable(entry.key, availability),
  )
    .map((entry) => ({
      entry,
      title: settingTitleOf(entry.key, messages),
      pageTitle: pageTitleOf(entry.page, messages),
      groupTitle: groupTitleOf(entry.group, messages),
    }))
    .filter(
      ({ entry, title, pageTitle, groupTitle }) =>
        title.toLowerCase().includes(needle) ||
        pageTitle.toLowerCase().includes(needle) ||
        groupTitle.toLowerCase().includes(needle) ||
        entry.aliases.some((alias) => alias.includes(needle)),
    );
};

/** Search hits grouped by page, in page order, for the results list. */
export const searchResultsByPage = (
  hits: SettingHit[],
): { page: SettingsPageMeta; hits: SettingHit[] }[] =>
  SETTINGS_PAGES.map((page) => ({
    page,
    hits: hits.filter((hit) => hit.entry.page === page.id),
  })).filter((group) => group.hits.length > 0);
