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

export const SETTING_ENTRIES: SettingEntry[] = [
  {
    key: "start_on_system_startup",
    section: "general",
    aliases: ["autostart", "launch", "boot"],
  },
  { key: "microphone", section: "general", aliases: ["mic", "input device"] },
  { key: "audio", section: "general", aliases: ["sound", "speaker", "volume"] },
  {
    key: "diagnostics",
    section: "general",
    aliases: ["debug", "logs", "troubleshoot"],
  },
  {
    key: "text_insertion_options",
    section: "dictation",
    aliases: ["paste", "typing", "insert"],
  },
  {
    key: "dictation_language",
    section: "dictation",
    aliases: ["language", "locale", "multilingual"],
  },
  {
    key: "dictation_limit_minutes",
    section: "dictation",
    aliases: ["max length", "timeout", "limit"],
  },
  {
    key: "hands_free_output_delay_ms",
    section: "dictation",
    aliases: ["delay", "handsfree", "wait"],
  },
  {
    key: "spoken_commands",
    section: "dictation",
    aliases: ["voice commands", "new line", "punctuation"],
  },
  {
    key: "real_time_output",
    section: "dictation",
    aliases: ["realtime", "streaming", "live"],
  },
  {
    key: "review_before_insert",
    section: "dictation",
    aliases: ["review", "composer", "approve"],
  },
  {
    key: "silence_hallucination_filter",
    section: "dictation",
    aliases: ["hallucination", "noise", "filter"],
  },
  {
    key: "switch_style_while_dictating",
    section: "dictation",
    aliases: ["cycle styles", "arrow keys"],
  },
  {
    key: "deepgram_api_key",
    section: "ai-processing",
    aliases: ["deepgram", "streaming", "api key"],
  },
  {
    key: "groq_api_key",
    section: "ai-processing",
    aliases: ["groq", "llm", "api key"],
  },
  {
    key: "ai_transcription",
    section: "ai-processing",
    aliases: ["stt", "speech to text", "model"],
  },
  {
    key: "ai_post_processing",
    section: "ai-processing",
    aliases: ["polish", "cleanup", "llm"],
  },
  {
    key: "assistant_mode",
    section: "ai-processing",
    aliases: ["agent", "chat", "assistant"],
  },
  {
    key: "automatic_style_loading",
    section: "ai-processing",
    aliases: ["auto load style"],
  },
  {
    key: "styling_mode",
    section: "ai-processing",
    aliases: ["app styles", "manual styles"],
  },
  {
    key: "show_menu_bar_icon",
    section: "pill-appearance",
    aliases: ["tray", "menu bar", "taskbar"],
  },
  {
    key: "dictation_pill_visibility",
    section: "pill-appearance",
    aliases: ["pill", "show pill", "hide pill"],
  },
  {
    key: "pill_placement",
    section: "pill-appearance",
    aliases: ["pill position", "top", "bottom", "anchor"],
  },
  {
    key: "reset_pill_position",
    section: "pill-appearance",
    aliases: ["pill monitor", "move pill"],
  },
  {
    key: "streak_celebrations",
    section: "pill-appearance",
    aliases: ["flame", "fireworks", "rewards"],
  },
  {
    key: "hotkey_shortcuts",
    section: "shortcuts",
    aliases: ["hotkey", "keyboard", "keybind"],
  },
  { key: "style_hotkeys", section: "shortcuts", aliases: ["style keys"] },
  {
    key: "incognito_mode",
    section: "privacy-data",
    aliases: ["private", "incognito", "no history"],
  },
  {
    key: "include_incognito_in_stats",
    section: "privacy-data",
    aliases: ["stats", "usage"],
  },
  {
    key: "auto_learn_dictionary",
    section: "privacy-data",
    aliases: ["autolearn", "dictionary", "corrections"],
  },
  {
    key: "learn_from_corrections",
    section: "privacy-data",
    aliases: ["watch edits"],
  },
  {
    key: "multi_device",
    section: "privacy-data",
    aliases: ["pair", "remote", "phone"],
  },
  {
    key: "clear_local_data",
    section: "privacy-data",
    aliases: ["danger zone", "delete data", "reset", "wipe"],
  },
  {
    key: "automatically_show_updates",
    section: "updates",
    aliases: ["auto update", "update popup"],
  },
  {
    key: "software_update",
    section: "updates",
    aliases: ["check for updates", "version", "check now"],
  },
  {
    key: "update_channel",
    section: "updates",
    aliases: ["beta", "stable", "prerelease", "channel"],
  },
  {
    key: "input_permissions",
    section: "advanced",
    aliases: ["uinput", "udev", "admin", "uac", "accessibility"],
  },
  {
    key: "configure_input_permissions",
    section: "advanced",
    aliases: ["setup permissions"],
  },
  {
    key: "always_run_as_administrator",
    section: "advanced",
    aliases: ["admin", "elevated", "uac"],
  },
  {
    key: "terms_conditions",
    section: "advanced",
    aliases: ["licence", "license", "legal"],
  },
];

export type SettingHit = {
  entry: SettingEntry;
  title: string;
  sectionTitle: string;
};

const messages = enMessages as Record<string, string>;
const sectionTitleOf = (section: SettingSectionId): string => {
  const meta = SETTING_SECTIONS.find((s) => s.id === section);
  return (meta && messages[meta.titleKey]) || section;
};

export const settingTitleOf = (key: string): string => messages[key] ?? key;

/** Case-insensitive substring match over title, section, and aliases. */
export const searchSettings = (query: string): SettingHit[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SETTING_ENTRIES.filter((entry) => {
    const title = (messages[entry.key] ?? entry.key).toLowerCase();
    if (title.includes(needle)) return true;
    if (sectionTitleOf(entry.section).toLowerCase().includes(needle)) {
      return true;
    }
    return entry.aliases.some((alias) => alias.includes(needle));
  }).map((entry) => ({
    entry,
    title: messages[entry.key] ?? entry.key,
    sectionTitle: sectionTitleOf(entry.section),
  }));
};
