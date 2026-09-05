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

  const lines = text.split("\n");
  const subtitlePresent = lines.some((line) =>
    line.split(/(?<=[.!?。！？])\s+/u).some(isSubtitleHallucination),
  );

  let changed = false;
  const keptLines: string[] = [];
  for (const line of lines) {
    const parts = line.split(/(?<=[.!?。！？])\s+/u);
    const kept = parts.filter((part) => {
      if (isKnownSilenceHallucination(part)) return false;
      if (subtitlePresent && isSilenceCompanion(part)) return false;
      return true;
    });
    if (kept.length === parts.length) {
      keptLines.push(line);
      continue;
    }
    changed = true;
    const rebuilt = kept
      .join(" ")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (rebuilt.length > 0) {
      keptLines.push(rebuilt);
    }
  }
  if (!changed) return text;
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
  // Prefer the caller-supplied (already overlap-merged) transcript whenever
  // segments are absent. When segments exist they belong to a single chunk.
  // noSpeechProb is a model confidence, not a language-specific phrase.
  // Always apply it when verbose segments are present — including for the
  // reachable `auto` language sentinel. Only the known-phrase filter below is
  // English-gated.
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
 * True when adjacent segment texts lack any boundary whitespace (`\s`, including
 * newlines and NBSP) and therefore need an inserted ASCII space. Detection is
 * deliberately broader than the collapse step below so a trailing `\n` still
 * counts as a separator and does not become `\n `.
 */
const needsSegmentSeparator = (left: string, right: string): boolean =>
  !/\s$/.test(left) && !/^\s/.test(right);

/**
 * Rebuild kept segment text with pairwise spacing.
 *
 * Whisper-style verbose_json often embeds a leading space on each segment.
 * Keep existing boundary whitespace and insert a single ASCII space only when
 * adjacent kept segments have none (so mixed styles neither glue words nor
 * double-space). The final collapse only touches space/tab runs so spoken
 * structural newlines (and NBSP) survive into the transcript.
 */
export const joinKeptSegmentTexts = (texts: string[]): string => {
  if (texts.length === 0) return "";
  let joined = texts[0] ?? "";
  let previous = joined;
  for (const text of texts.slice(1)) {
    joined += needsSegmentSeparator(previous, text) ? ` ${text}` : text;
    previous = text;
  }
  // Space/tab only — do not collapse `\n` or NBSP here.
  return joined.replace(/[ \t]+/g, " ").trim();
};

/**
 * Drop clearly-silent segments from a `verbose_json` response and concatenate
 * the remainder. Returns null (not "") when no segments are supplied so callers
 * can fall back to the exact provider text — providers that don't return
 * `verbose_json` output (e.g. some OpenAI-compatible endpoints) simply bypass
 * this gate.
 *
 * The probability is model metadata and is language-agnostic. Do not gate it
 * on a BCP-47 language or on sentinels such as `auto`; language gating belongs
 * only to the conservative known-phrase filter.
 */
export const gateSilentSegments = (
  segments: TranscriptionSegment[] | undefined | null,
): string | null => {
  if (!segments || segments.length === 0) {
    return null;
  }
  const kept = segments.filter(
    (segment) =>
      segment.noSpeechProb == null ||
      segment.noSpeechProb < NO_SPEECH_PROB_THRESHOLD,
  );
  // Nothing gated — keep the provider transcript (and its spacing) instead
  // of rebuilding from segments.
  if (kept.length === segments.length) {
    return null;
  }
  return joinKeptSegmentTexts(kept.map((segment) => segment.text));
};
