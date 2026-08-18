import { isEnglishSanitizeLanguage } from "./sanitize-language.utils";

/**
 * Common phrases emitted by Whisper-like models when the input contains only
 * room noise or silence. Keep this list intentionally conservative: filtering
 * is applied before post-processing and should never rewrite a real sentence.
 *
 * Phrase filter is what the live sanitize path uses. gateSilentSegments is
 * available when a provider supplies verbose_json segments; this branch's
 * sanitize pipeline does not invent those segments.
 */
export const KNOWN_SILENCE_HALLUCINATIONS = [
  "[blank_audio]",
  "[blank audio]",
  "[silence]",
  "(silence)",
  "thank you for watching",
  "thanks for watching",
  "subtitles by the amara.org community",
  "subtitles by the amara.org community.",
] as const;

export const SUBTITLE_HALLUCINATION_PHRASES = [
  "subtitles by the amara.org community",
  "subtitles by the amara.org community.",
] as const;

export const SILENCE_HALLUCINATION_COMPANIONS = ["best regards."] as const;

const normalizeHallucinationText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?,;:。！？，、]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const isKnownSilenceHallucination = (text: string): boolean => {
  const normalized = normalizeHallucinationText(text);
  return KNOWN_SILENCE_HALLUCINATIONS.some(
    (phrase) => normalized === normalizeHallucinationText(phrase),
  );
};

const isSubtitleHallucination = (part: string): boolean => {
  const normalized = normalizeHallucinationText(part);
  return (SUBTITLE_HALLUCINATION_PHRASES as readonly string[]).some(
    (phrase) => normalized === normalizeHallucinationText(phrase),
  );
};

const isSilenceCompanion = (part: string): boolean => {
  const normalized = normalizeHallucinationText(part);
  return (SILENCE_HALLUCINATION_COMPANIONS as readonly string[]).some(
    (phrase) => normalized === normalizeHallucinationText(phrase),
  );
};

/**
 * Remove known hallucination-only lines while preserving surrounding speech.
 * A phrase is removed only when it is a complete line/sentence, never when it
 * appears inside a longer sentence.
 *
 * Non-English `language` disables the filter. Omitting `language` keeps the
 * historical always-filter behavior (PR #63 contract).
 */
export const filterKnownSilenceHallucinations = (
  text: string,
  language?: string,
): string => {
  if (!text.trim()) return "";
  if (language !== undefined && !isEnglishSanitizeLanguage(language)) {
    return text;
  }
  if (isKnownSilenceHallucination(text)) return "";

  const parts = text.split(/(?<=[.!?。！？])\s+|\n+/u);
  const subtitlePresent = parts.some(isSubtitleHallucination);

  const kept = parts.filter((part) => {
    if (isKnownSilenceHallucination(part)) return false;
    if (subtitlePresent && isSilenceCompanion(part)) return false;
    return true;
  });
  return kept.join(" ").replace(/\s+/g, " ").trim();
};

export type TranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
};

export const NO_SPEECH_PROB_THRESHOLD = 0.9;

export const gateSilentSegments = (
  segments: TranscriptionSegment[] | undefined | null,
): string | null => {
  if (!segments || segments.length === 0) {
    return null;
  }
  return segments
    .filter(
      (segment) =>
        segment.noSpeechProb == null ||
        segment.noSpeechProb < NO_SPEECH_PROB_THRESHOLD,
    )
    .map((segment) => segment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
};

export const applyHallucinationFiltering = (
  rawTranscript: string,
  segments: TranscriptionSegment[] | undefined | null,
  language: string | undefined,
  filterEnabled: boolean,
): string => {
  if (!filterEnabled) {
    return rawTranscript;
  }
  const gated = gateSilentSegments(segments);
  const transcriptForFiltering = gated ?? rawTranscript;
  return filterKnownSilenceHallucinations(transcriptForFiltering, language);
};
