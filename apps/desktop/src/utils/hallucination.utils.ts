/**
 * Common phrases emitted by Whisper-like models when the input contains only
 * room noise or silence. Keep this list intentionally conservative: filtering
 * is applied before post-processing and should never rewrite a real sentence.
 */
export const KNOWN_SILENCE_HALLUCINATIONS = [
  "[blank_audio]",
  "[blank audio]",
  "[silence]",
  "(silence)",
  "thank you for watching",
  "thanks for watching",
  "字幕由amara.org社区提供",
  "ご視聴ありがとうございました",
] as const;

const normalizeHallucinationText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?,;:。！？，、]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Return true when a decoded result is a known silence-only hallucination. */
export const isKnownSilenceHallucination = (text: string): boolean => {
  const normalized = normalizeHallucinationText(text);
  return KNOWN_SILENCE_HALLUCINATIONS.some(
    (phrase) => normalized === normalizeHallucinationText(phrase),
  );
};

/**
 * Remove known hallucination-only lines while preserving surrounding speech.
 * A phrase is removed only when it is a complete line/sentence, never when it
 * appears inside a longer sentence.
 */
export const filterKnownSilenceHallucinations = (text: string): string => {
  if (!text.trim()) return "";
  if (isKnownSilenceHallucination(text)) return "";

  const kept = text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .filter((part) => !isKnownSilenceHallucination(part));
  return kept.join(" ").replace(/\s+/g, " ").trim();
};
