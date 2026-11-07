import { getRec } from "@maus-inc/utilities";
import { getIntl, matchSupportedLocale } from "../i18n";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";

export const LANGUAGE_DISPLAY_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  "pt-BR": "Português (Brasil)",
  it: "Italiano",
  "zh-TW": "中文 (台灣)",
  "zh-CN": "中文 (简体)",
  ko: "한국어",
};

/** These are languages supported by Whisper for transcription */
export const WHISPER_LANGUAGES = {
  en: "English",
  zh: "中文",
  de: "Deutsch",
  es: "Español",
  ru: "Русский",
  ko: "한국어",
  fr: "Français",
  ja: "日本語",
  pt: "Português",
  tr: "Türkçe",
  pl: "Polski",
  ca: "Català",
  nl: "Nederlands",
  ar: "العربية",
  sv: "Svenska",
  it: "Italiano",
  id: "Bahasa Indonesia",
  hi: "हिन्दी",
  fi: "Suomi",
  vi: "Tiếng Việt",
  he: "עברית",
  uk: "Українська",
  el: "Ελληνικά",
  ms: "Bahasa Melayu",
  cs: "Čeština",
  ro: "Română",
  da: "Dansk",
  hu: "Magyar",
  ta: "தமிழ்",
  no: "Norsk",
  th: "ไทย",
  ur: "اردو",
  hr: "Hrvatski",
  bg: "Български",
  lt: "Lietuvių",
  la: "Latina",
  mi: "Māori",
  ml: "മലയാളം",
  cy: "Cymraeg",
  sk: "Slovenčina",
  te: "తెలుగు",
  fa: "فارسی",
  lv: "Latviešu",
  bn: "বাংলা",
  sr: "Српски",
  az: "Azərbaycan",
  sl: "Slovenščina",
  kn: "ಕನ್ನಡ",
  et: "Eesti",
  mk: "Македонски",
  br: "Brezhoneg",
  eu: "Euskara",
  is: "Íslenska",
  hy: "Հայերեն",
  ne: "नेपाली",
  mn: "Монгол",
  bs: "Bosanski",
  kk: "Қазақша",
  sq: "Shqip",
  sw: "Kiswahili",
  gl: "Galego",
  mr: "मराठी",
  pa: "ਪੰਜਾਬੀ",
  si: "සිංහල",
  km: "ខ្មែរ",
  sn: "Shona",
  yo: "Yorùbá",
  so: "Soomaali",
  af: "Afrikaans",
  oc: "Occitan",
  ka: "ქართული",
  be: "Беларуская",
  tg: "Тоҷикӣ",
  sd: "سنڌي",
  gu: "ગુજરાતી",
  am: "አማርኛ",
  yi: "ייִדיש",
  lo: "ລາວ",
  uz: "Oʻzbek",
  fo: "Føroyskt",
  ht: "Kreyòl Ayisyen",
  ps: "پښتو",
  tk: "Türkmen",
  nn: "Nynorsk",
  mt: "Malti",
  sa: "संस्कृतम्",
  lb: "Lëtzebuergesch",
  my: "မြန်မာ",
  bo: "བོད་སྐད་",
  tl: "Tagalog",
  mg: "Malagasy",
  as: "অসমীয়া",
  tt: "Татар",
  haw: "ʻŌlelo Hawaiʻi",
  ln: "Lingála",
  ha: "Hausa",
  ba: "Башҡорт",
  jw: "Basa Jawa",
  su: "Basa Sunda",
  yue: "粵語",
};

export const AUTO_LANGUAGE = "auto";

/**
 * Sentinel value stored as the Active Dictation Language meaning "follow the
 * Primary Dictation Language" rather than a concrete language code.
 */
export const PRIMARY_LANGUAGE_SENTINEL = "primary";

/** These are all the supported languages. Anything not supported by Whisper needs to be post processed into the language of choice */
export const DICTATION_LANGUAGES = {
  [AUTO_LANGUAGE]: "Auto-detect",
  ...WHISPER_LANGUAGES,

  // chinese (Traditional Chinese (Taiwan), Traditional Chinese (Hong Kong), and Simplified Chinese)
  "zh-TW": "中文 (台灣)",
  "zh-HK": "中文 (香港)",
  "zh-CN": "中文 (简体)",

  // Portuguese (Portugal and Brazil)
  "pt-PT": "Português (Portugal)",
  "pt-BR": "Português (Brasil)",
};

export type DictationLanguageCode = keyof typeof DICTATION_LANGUAGES;

export const ORDERED_DICTATION_LANGUAGES: DictationLanguageCode[] = [
  "en",
  "es",
  "de",
  "zh",
  "zh-TW",
  "zh-HK",
  "zh-CN",
  "ru",
  "ko",
  "fr",
  "ja",
  "pt",
  "pt-PT",
  "pt-BR",
  "tr",
  "pl",
  "ca",
  "nl",
  "ar",
  "sv",
  "it",
  "id",
  "hi",
  "fi",
  "vi",
  "he",
  "uk",
  "el",
  "ms",
  "cs",
  "ro",
  "da",
  "hu",
  "ta",
  "no",
  "th",
  "ur",
  "hr",
  "bg",
  "lt",
  "la",
  "mi",
  "ml",
  "cy",
  "sk",
  "te",
  "fa",
  "lv",
  "bn",
  "sr",
  "az",
  "sl",
  "kn",
  "et",
  "mk",
  "br",
  "eu",
  "is",
  "hy",
  "ne",
  "mn",
  "bs",
  "kk",
  "sq",
  "sw",
  "gl",
  "mr",
  "pa",
  "si",
  "km",
  "sn",
  "yo",
  "so",
  "af",
  "oc",
  "ka",
  "be",
  "tg",
  "sd",
  "gu",
  "am",
  "yi",
  "lo",
  "uz",
  "fo",
  "ht",
  "ps",
  "tk",
  "nn",
  "mt",
  "sa",
  "lb",
  "my",
  "bo",
  "tl",
  "mg",
  "as",
  "tt",
  "haw",
  "ln",
  "ha",
  "ba",
  "jw",
  "su",
  "yue",
];

export const coerceToDictationLanguage = (
  language: string,
): DictationLanguageCode => {
  if (language === AUTO_LANGUAGE) {
    return AUTO_LANGUAGE;
  }

  if (DICTATION_LANGUAGES[language as DictationLanguageCode]) {
    return language as DictationLanguageCode;
  }

  const baseLanguage = language.split("-")[0];
  if (DICTATION_LANGUAGES[baseLanguage as DictationLanguageCode]) {
    return baseLanguage as DictationLanguageCode;
  }

  throw new Error(`Unsupported dictation language: ${language}`);
};

export const KEYBOARD_LAYOUT_LANGUAGE = "keyboard-layout";

/**
 * The code a language Select can actually hold. A stored preference and the
 * detected system locale are both locale-shaped (`en-US`), and neither
 * `AUTO_LANGUAGE` nor any language key is: a Select given one renders blank and
 * a submit sends a value no provider accepts. Anything that cannot be narrowed
 * to a supported language falls back to auto-detect, which the user can see and
 * change.
 */
/**
 * `DICTATION_LANGUAGES` is a plain object, so `catalog[input]` finds anything on
 * `Object.prototype` as readily as a language: `toString` and `constructor` are
 * truthy there, and a Select given one renders blank just as it would for an
 * unknown locale. The own-property check is what makes the answer a language.
 */
const asLanguageCode = (candidate: string): DictationLanguageCode | null =>
  Object.hasOwn(DICTATION_LANGUAGES, candidate)
    ? (candidate as DictationLanguageCode)
    : null;

export const toSelectableDictationLanguage = (
  language: string,
): DictationLanguageCode => {
  if (language === AUTO_LANGUAGE || language === KEYBOARD_LAYOUT_LANGUAGE) {
    return AUTO_LANGUAGE;
  }
  const exact = asLanguageCode(language);
  if (exact) return exact;
  return asLanguageCode(language.split("-")[0]) ?? AUTO_LANGUAGE;
};
const getKeyboardLayoutTranslation = () =>
  getIntl().formatMessage({
    id: "keyboard_layout",
    defaultMessage: "Keyboard layout",
  });

/**
 * Endonyms written in a script the app cannot guarantee to render fall back
 * to their English exonym. QA showed the raw endonyms turning into tofu
 * boxes on systems without CJK/Arabic/Devanagari/Greek/Hebrew/Thai fonts —
 * a picker must not gamble on client font coverage, so those languages use
 * exonyms (the same call VS Code and GitHub make in their language
 * pickers). Latin and Cyrillic endonyms render everywhere the app runs, so
 * they stay native.
 */
const LANGUAGE_EXONYMS: Partial<Record<DictationLanguageCode, string>> = {
  el: "Greek",
  he: "Hebrew",
  yi: "Yiddish",
  ar: "Arabic",
  ur: "Urdu",
  ps: "Pashto",
  sd: "Sindhi",
  fa: "Persian",
  hi: "Hindi",
  ne: "Nepali",
  mr: "Marathi",
  sa: "Sanskrit",
  bn: "Bengali",
  as: "Assamese",
  pa: "Punjabi",
  gu: "Gujarati",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
  si: "Sinhala",
  th: "Thai",
  lo: "Lao",
  km: "Khmer",
  my: "Burmese",
  bo: "Tibetan",
  am: "Amharic",
  hy: "Armenian",
  ka: "Georgian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  "zh-TW": "Chinese (Taiwan)",
  "zh-HK": "Chinese (Hong Kong)",
  "zh-CN": "Chinese (Simplified)",
  yue: "Cantonese",
};

/**
 * The label a language menu shows for a code: the native endonym when its
 * script is guaranteed to render, the English exonym otherwise.
 */
export const getRenderSafeLanguageLabel = (
  code: DictationLanguageCode,
): string => LANGUAGE_EXONYMS[code] ?? DICTATION_LANGUAGES[code];

export const DICTATION_LANGUAGE_OPTIONS: [string, string][] = [
  [AUTO_LANGUAGE, DICTATION_LANGUAGES[AUTO_LANGUAGE]],
  [KEYBOARD_LAYOUT_LANGUAGE, getKeyboardLayoutTranslation()],
  ...ORDERED_DICTATION_LANGUAGES.map<[string, string]>((code) => [
    code,
    getRenderSafeLanguageLabel(code),
  ]),
];

export const getDisplayNameForLanguage = (code: string): string => {
  const baseCode = code.split("-")[0];
  return (
    getRec(WHISPER_LANGUAGES, baseCode) ??
    LANGUAGE_DISPLAY_NAMES[code as Locale] ??
    code
  );
};

export const resolveLocaleValue = (value?: string | null): Locale => {
  return matchSupportedLocale(value) ?? DEFAULT_LOCALE;
};

export const mapDictationLanguageToWhisperLanguage = (
  language: string,
): string => {
  if (language === AUTO_LANGUAGE) {
    return AUTO_LANGUAGE;
  }
  const baseLanguage = language.split("-")[0];
  return baseLanguage;
};
