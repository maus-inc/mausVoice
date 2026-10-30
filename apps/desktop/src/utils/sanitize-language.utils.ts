/**
 * Strict English gate for language-specific sanitize steps such as the known
 * silence-phrase filter. Sentinels ("primary", "auto") are not BCP-47 English.
 * Spoken commands layer its documented `auto` policy on top of this helper;
 * the language-agnostic noSpeechProb gate does not call it at all.
 */
export const isEnglishSanitizeLanguage = (
  language: string | undefined,
): boolean => {
  if (language === undefined) {
    return true;
  }
  const normalized = language.toLowerCase().trim();
  return (
    normalized === "en" ||
    normalized === "english" ||
    normalized.startsWith("en-")
  );
};
