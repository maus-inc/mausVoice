/**
 * English gate for deterministic sanitize steps (spoken commands +
 * silence-hallucination filter).
 *
 * Sentinels ("primary", "auto") are NOT English. Callers must pass a
 * resolved BCP-47 (e.g. getMyDictationLanguage), never the stored
 * activeDictationLanguage sentinel.
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
