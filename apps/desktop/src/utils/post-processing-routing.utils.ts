/**
 * Decides whether one dictation is styled by the local transforms or sent to
 * the configured provider.
 *
 * The two paths do not produce the same text. The local path is a set of
 * deterministic edits with no model, and the provider path is a model reading
 * the whole style prompt. For a short dictation the difference is small and the
 * latency difference is not: every provider request carries the full style
 * prompt and a reasoning-token floor, so a three-word dictation pays the same
 * fixed cost as a paragraph. For a long dictation the provider's edits are the
 * ones that make the text read well, so length is the line between the two.
 *
 * The thresholds are deliberately tight. A dictation that routes locally and
 * should not have loses quality; one that routes to the provider and should not
 * have costs a second. The second error is the cheaper one, so a dictation
 * routes locally only when it is a word, a sentence, or about two sentences:
 * at most two sentences, at most thirty words, and at most two hundred
 * characters, which is also the bound that holds for a run-on dictation that
 * never received a terminator.
 */
import { Nullable } from "@maus-inc/types";
import {
  FAST_STYLE_PROSE_TONE_IDS,
  countFastStyleSentences,
} from "./fast-style.utils";
import { isEnglishSanitizeLanguage } from "./sanitize-language.utils";
import { countWords } from "./string.utils";

/** At most this many sentences, under the transforms' own sentence definition. */
export const SHORT_DICTATION_MAX_SENTENCES = 2;
/** At most this many whitespace-separated words. */
export const SHORT_DICTATION_MAX_WORDS = 30;
/**
 * At most this many characters. This is the bound that holds for scripts
 * without spaces, where the word count is 1 for the whole input, and it also
 * caps a run-on dictation that never received a terminator.
 */
export const SHORT_DICTATION_MAX_CHARS = 200;

export type PostProcessingRoute = "local" | "api";

/**
 * Why the route was chosen. Logged, and asserted from tests, so a report of
 * "my short dictation went to the API" can be answered instead of guessed at.
 */
export type PostProcessingRouteReason =
  | "local-short-dictation"
  | "api-routing-disabled"
  | "api-non-english-dictation"
  | "api-tone-has-no-local-prose-transform"
  | "api-dictation-not-short";

export type PostProcessingRouteDecision = {
  route: PostProcessingRoute;
  reason: PostProcessingRouteReason;
};

/**
 * Whether the text is short enough for the deterministic local transforms.
 *
 * An empty text is not short, it is absent: the caller has nothing to style.
 */
export const isShortDictation = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > SHORT_DICTATION_MAX_CHARS) return false;
  if (countWords(trimmed) > SHORT_DICTATION_MAX_WORDS) return false;
  return countFastStyleSentences(trimmed) <= SHORT_DICTATION_MAX_SENTENCES;
};

/**
 * The route for one dictation, and the reason for it.
 *
 * `enabled` is the user preference, and it is read by the caller rather than
 * here so this stays a pure function. A tone without a local prose transform
 * (email, bullets, notes, a custom tone) always takes the provider: those
 * transforms restructure the text, and that is the half an LLM does better.
 *
 * The transforms are English-only, and they delete words: "um" is a filler in
 * English and a preposition in German, so a German dictation styled locally
 * came back as "Wir treffen uns am montag drei uhr". The language is therefore
 * a hard condition, and a dictation the app cannot place as English by its
 * language setting keeps the provider path it had before this feature.
 */
export const resolvePostProcessingRoute = (args: {
  transcript: string;
  toneId: Nullable<string>;
  enabled: boolean;
  /** The dictation language as a code or a sentinel, never the transcript. */
  language: string;
}): PostProcessingRouteDecision => {
  if (!args.enabled) {
    return { route: "api", reason: "api-routing-disabled" };
  }
  if (!isEnglishSanitizeLanguage(args.language)) {
    return { route: "api", reason: "api-non-english-dictation" };
  }
  if (!args.toneId || !FAST_STYLE_PROSE_TONE_IDS.has(args.toneId)) {
    return { route: "api", reason: "api-tone-has-no-local-prose-transform" };
  }
  if (!isShortDictation(args.transcript)) {
    return { route: "api", reason: "api-dictation-not-short" };
  }
  return { route: "local", reason: "local-short-dictation" };
};
