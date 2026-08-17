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
  // Cloud transcription (e.g. Groq) sometimes fabricates a subtitle credit and
  // a closing sign-off on silent audio; see issue #54 / voquill#446. Both the
  // bare phrase and the trailing-period variant are listed for clarity even
  // though `normalizeHallucinationText` strips terminal punctuation, so they
  // collapse to the same normalized form.
  "subtitles by the amara.org community",
  "subtitles by the amara.org community.",
  "best regards.",
] as const;

const normalizeHallucinationText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.!?,;:。！？，、]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isEnglishLanguage = (language: string): boolean => {
  const normalized = language.toLowerCase().trim();
  return (
    normalized === "en" ||
    normalized === "english" ||
    normalized.startsWith("en-")
  );
};

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
 *
 * The `KNOWN_SILENCE_HALLUCINATIONS` list is tuned for English. Passing a
 * non-English `language` disables the filter for that transcription so the
 * phrases can't be stripped out of genuine speech in other languages. When
 * callers can't supply a language (legacy paths or tests) the historical
 * always-filter behavior is preserved by omitting the argument.
 */
export const filterKnownSilenceHallucinations = (
  text: string,
  language?: string,
): string => {
  if (!text.trim()) return "";
  if (language !== undefined && !isEnglishLanguage(language)) {
    return text;
  }
  if (isKnownSilenceHallucination(text)) return "";

  const kept = text
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .filter((part) => !isKnownSilenceHallucination(part));
  return kept.join(" ").replace(/\s+/g, " ").trim();
};

/**
 * A single Whisper segment as returned by a `verbose_json` transcription.
 * `noSpeechProb` is the model's estimate that the segment contains no speech.
 */
export type TranscriptionSegment = {
  text: string;
  noSpeechProb?: number;
};

/**
 * Segments whose `no_speech_prob` meets or exceeds this are treated as
 * near-certain silence and dropped. The 0.9 threshold is deliberately
 * conservative so only clearly-silent segments are removed; genuine speech
 * (even quiet speech) is preserved verbatim. This mirrors the local RMS energy
 * gate that runs before inference for on-device transcription.
 */
export const NO_SPEECH_PROB_THRESHOLD = 0.9;

/**
 * Drop clearly-silent segments from a `verbose_json` response and concatenate
 * the remainder. Returns null (not "") when no segments are supplied so callers
 * can fall back to the exact provider text — providers that don't return
 * `verbose_json` output (e.g. some OpenAI-compatible endpoints) simply bypass
 * this gate.
 */
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
