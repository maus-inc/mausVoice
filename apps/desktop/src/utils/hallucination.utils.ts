import { isEnglishSanitizeLanguage } from "./sanitize-language.utils";

/**
 * Common phrases emitted by Whisper-like models when the input contains only
 * room noise or silence. Keep this list intentionally conservative: filtering
 * is applied before post-processing and should never rewrite a real sentence.
 */
// English-only list: `applyHallucinationFiltering` short-circuits and returns the
// text unchanged for any non-English `language`, so a non-English phrase added here
// would be dead code (never reached). Keep additions English.
export const KNOWN_SILENCE_HALLUCINATIONS = [
  "[blank_audio]",
  "[blank audio]",
  "[silence]",
  "(silence)",
  "thank you for watching",
  "thanks for watching",
  // Cloud transcription (e.g. Groq) sometimes fabricates a subtitle credit on
  // silent audio; see issue #54 / voquill#446. Both the bare phrase and the
  // trailing-period variant are listed for clarity even though
  // `normalizeHallucinationText` strips terminal punctuation, so they collapse
  // to the same normalized form.
  "subtitles by the amara.org community",
  "subtitles by the amara.org community.",
] as const;

/**
 * Subtitle/Amara credit hallucinations. When one of these is present, a nearby
 * fabricated sign-off (see SILENCE_HALLUCINATION_COMPANIONS) is almost
 * certainly part of the same hallucinated artifact and is safe to drop.
 */
export const SUBTITLE_HALLUCINATION_PHRASES = [
  "subtitles by the amara.org community",
  "subtitles by the amara.org community.",
] as const;

/**
 * Phrases that look like genuine content on their own but are fabricated by
 * cloud models alongside the Amara/subtitle hallucination. They are only
 * stripped when a SUBTITLE_HALLUCINATION_PHRASES entry is also present (or when
 * the whole segment is dropped by probability gating), so a real dictated
 * "Best regards." email sign-off survives.
 */
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
 * historical always-filter behavior.
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

  const lines = text.split(/\n+/);
  const subtitlePresent = lines.some((line) =>
    line.split(/(?<=[.!?。！？])\s+/u).some(isSubtitleHallucination),
  );

  const keptLines = lines
    .map((line) => {
      const parts = line.split(/(?<=[.!?。！？])\s+/u);
      const kept = parts.filter((part) => {
        if (isKnownSilenceHallucination(part)) return false;
        if (subtitlePresent && isSilenceCompanion(part)) return false;
        return true;
      });
      return kept.join(" ").replace(/[ \t]+/g, " ").trim();
    })
    .filter((line) => line.length > 0);
  return keptLines.join("\n");
};

/**
 * Apply the full hallucination-mitigation pipeline to a provider result.
 *
 * When `filterEnabled` is false the raw transcript is returned EXACTLY — no
 * probability gating and no phrase filtering — so the user's off-switch
 * preserves content verbatim. Otherwise near-certain-silence segments are
 * dropped (probability gate) and known silence phrases are filtered from the
 * remainder.
 */
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
