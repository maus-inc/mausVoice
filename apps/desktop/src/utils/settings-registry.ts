import enMessages from "../i18n/locales/en.json";

export type SettingSectionId =
  | "general"
  | "dictation"
  | "ai-processing"
  | "pill-appearance"
  | "shortcuts"
  | "privacy-data"
  | "updates"
  | "advanced";

export type SettingSectionMeta = {
  id: SettingSectionId;
  titleKey: string;
};

export const SETTING_SECTIONS: SettingSectionMeta[] = [
  { id: "general", titleKey: "general" },
  { id: "dictation", titleKey: "dictation" },
  { id: "ai-processing", titleKey: "ai_and_processing" },
  { id: "pill-appearance", titleKey: "pill_and_appearance" },
  { id: "shortcuts", titleKey: "shortcuts" },
  { id: "privacy-data", titleKey: "privacy_and_data" },
  { id: "updates", titleKey: "updates" },
  { id: "advanced", titleKey: "advanced" },
];

export type SettingEntry = {
  /** en.json key: the single source of the tile title. */
  key: string;
  section: SettingSectionId;
  /** Lowercase synonyms the title alone would miss. */
  aliases: string[];
};

const settingsForSection = (
  section: SettingSectionId,
  aliasesByKey: Record<string, string[]>,
): SettingEntry[] =>
  Object.entries(aliasesByKey).map(([key, aliases]) => ({
    key,
    section,
    aliases,
  }));

export const SETTING_ENTRIES: SettingEntry[] = [
  ...settingsForSection("general", {
    start_on_system_startup: ["autostart", "launch", "boot"],
    microphone: ["mic", "input device"],
    audio: ["sound", "speaker", "volume"],
    diagnostics: ["debug", "logs", "troubleshoot"],
  }),
  ...settingsForSection("dictation", {
    text_insertion_options: ["paste", "typing", "insert"],
    dictation_language: ["language", "locale", "multilingual"],
    dictation_limit_minutes: ["max length", "timeout", "limit"],
    hands_free_output_delay_ms: ["delay", "handsfree", "wait"],
    spoken_commands: ["voice commands", "new line", "punctuation"],
    real_time_output: ["realtime", "streaming", "live"],
    review_before_insert: ["review", "composer", "approve"],
    silence_hallucination_filter: ["hallucination", "noise", "filter"],
    switch_style_while_dictating: ["cycle styles", "arrow keys"],
  }),
  ...settingsForSection("ai-processing", {
    deepgram_api_key: ["deepgram", "streaming", "api key"],
    groq_api_key: ["groq", "llm", "api key"],
    ai_transcription: ["stt", "speech to text", "model"],
    ai_post_processing: ["polish", "cleanup", "llm"],
    assistant_mode: ["agent", "chat", "assistant"],
    automatic_style_loading: ["auto load style"],
    styling_mode: ["app styles", "manual styles"],
  }),
  ...settingsForSection("pill-appearance", {
    show_menu_bar_icon: ["tray", "menu bar", "taskbar"],
    dictation_pill_visibility: ["pill", "show pill", "hide pill"],
    pill_placement: ["pill position", "top", "bottom", "anchor"],
    reset_pill_position: ["pill monitor", "move pill"],
    streak_celebrations: ["flame", "fireworks", "rewards"],
  }),
  ...settingsForSection("shortcuts", {
    hotkey_shortcuts: ["hotkey", "keyboard", "keybind"],
    style_hotkeys: ["style keys"],
  }),
  ...settingsForSection("privacy-data", {
    incognito_mode: ["private", "incognito", "no history"],
    include_incognito_in_stats: ["stats", "usage"],
    preserve_audio_on_failure: ["failed audio", "replay", "snapshot"],
    elevenlabs_keyterms: ["keyterms", "surcharge", "elevenlabs"],
    auto_learn_dictionary: ["autolearn", "dictionary", "corrections"],
    learn_from_corrections: ["watch edits"],
    multi_device: ["pair", "remote", "phone"],
    clear_local_data: ["danger zone", "delete data", "reset", "wipe"],
  }),
  ...settingsForSection("updates", {
    automatically_show_updates: ["auto update", "update popup"],
    software_update: ["check for updates", "version", "check now"],
    update_channel: ["beta", "stable", "prerelease", "channel"],
  }),
  ...settingsForSection("advanced", {
    input_permissions: ["uinput", "udev", "admin", "uac", "accessibility"],
    configure_input_permissions: ["setup permissions"],
    always_run_as_administrator: ["admin", "elevated", "uac"],
    terms_conditions: ["licence", "license", "legal"],
  }),
];

export type SettingHit = {
  entry: SettingEntry;
  title: string;
  sectionTitle: string;
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

const sectionTitleOf = (
  section: SettingSectionId,
  messages?: SettingsSearchOptions["messages"],
): string => {
  const meta = SETTING_SECTIONS.find((entry) => entry.id === section);
  return meta ? settingTitleOf(meta.titleKey, messages) : section;
};

/** Match available controls using localized titles and shared search aliases. */
export const searchSettings = (
  query: string,
  { availability, messages }: SettingsSearchOptions = {},
): SettingHit[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SETTING_ENTRIES.filter((entry) => availability?.[entry.key] !== false)
    .map((entry) => ({
      entry,
      title: settingTitleOf(entry.key, messages),
      sectionTitle: sectionTitleOf(entry.section, messages),
    }))
    .filter(
      ({ entry, title, sectionTitle }) =>
        title.toLowerCase().includes(needle) ||
        sectionTitle.toLowerCase().includes(needle) ||
        entry.aliases.some((alias) => alias.includes(needle)),
    );
};
