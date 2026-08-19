import { getStringSimilarity } from "./string.utils";

/**
 * Normalizes text for comparison by removing punctuation, hyphens, and lowercasing.
 * This creates a canonical form for fuzzy matching.
 */
const normalizeText = (text: string): string => {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}-]/g, "") // Remove punctuation including hyphens
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
};

/** Minimum similarity threshold for considering two text segments as matching */
const SIMILARITY_THRESHOLD = 0.75;

/**
 * Result of finding overlap between two transcriptions.
 * - wordsToKeepFromFirst: number of words to keep from first transcription
 * - wordsToSkipFromSecond: number of words to skip from start of second transcription
 */
type OverlapResult = {
  wordsToKeepFromFirst: number;
  wordsToSkipFromSecond: number;
};

/** Threshold for considering a match "exact" (same word count, very high similarity) */
const EXACT_MATCH_THRESHOLD = 0.9;

/**
 * Finds the best overlap between two transcriptions using fuzzy string matching.
 * This handles contractions ("that's" vs "that is"), hyphens ("slow-moving" vs "slow moving"),
 * punctuation differences, and minor transcription errors.
 */
type BestOverlap = {
  i: number; // words from end of first
  j: number; // words from start of second
  similarity: number;
  isExact: boolean;
};

const scoreOverlap = (
  j: number,
  similarity: number,
  isExact: boolean,
): number => j * 10 + (isExact ? 5 : 0) + similarity;

const findBestOverlap = (
  firstWords: string[],
  secondWords: string[],
): BestOverlap | null => {
  const maxIToCheck = Math.min(firstWords.length, 30);
  const maxJToCheck = Math.min(secondWords.length, 30);
  let best: BestOverlap | null = null;

  for (let i = 1; i <= maxIToCheck; i++) {
    const normalizedFirst = normalizeText(firstWords.slice(-i).join(" "));

    for (let j = 1; j <= maxJToCheck; j++) {
      const normalizedSecond = normalizeText(secondWords.slice(0, j).join(" "));

      const lengthRatio =
        Math.min(normalizedFirst.length, normalizedSecond.length) /
        Math.max(normalizedFirst.length, normalizedSecond.length);
      if (lengthRatio < 0.5) continue;

      const similarity = getStringSimilarity(normalizedFirst, normalizedSecond);
      if (similarity < SIMILARITY_THRESHOLD) continue;

      const isExact = i === j && similarity >= EXACT_MATCH_THRESHOLD;
      const score = scoreOverlap(j, similarity, isExact);
      const beatsBest =
        best === null ||
        score > scoreOverlap(best.j, best.similarity, best.isExact);

      if (beatsBest) {
        best = { i, j, similarity, isExact };
      }
    }
  }

  return best;
};

const findTruncatedPrefixOverlap = (
  firstWords: string[],
  secondWords: string[],
): boolean => {
  if (secondWords.length === 0) {
    return false;
  }
  // e.g., "hello wor" + "world peace" → "wor" is prefix of "world"
  const lastWordOfFirst = normalizeText(firstWords.at(-1) ?? "");
  const firstWordOfSecond = normalizeText(secondWords[0]);
  return (
    lastWordOfFirst.length >= 2 &&
    firstWordOfSecond.startsWith(lastWordOfFirst) &&
    lastWordOfFirst.length < firstWordOfSecond.length
  );
};

const findExactMatchAfterDroppingLastWord = (
  firstWords: string[],
  secondWords: string[],
): number | null => {
  const firstWithoutLast = firstWords.slice(0, -1);
  const maxIToCheck = Math.min(firstWithoutLast.length, 30);
  const maxJToCheck = Math.min(secondWords.length, 30);

  for (let i = 1; i <= maxIToCheck; i++) {
    const normalizedFirst = normalizeText(firstWithoutLast.slice(-i).join(" "));

    for (let j = 1; j <= maxJToCheck; j++) {
      const normalizedSecond = normalizeText(secondWords.slice(0, j).join(" "));

      const lengthRatio =
        Math.min(normalizedFirst.length, normalizedSecond.length) /
        Math.max(normalizedFirst.length, normalizedSecond.length);
      if (lengthRatio < 0.5) continue;

      const similarity = getStringSimilarity(normalizedFirst, normalizedSecond);
      if (similarity >= EXACT_MATCH_THRESHOLD && i === j) {
        return j;
      }
    }
  }

  return null;
};

const findOverlap = (first: string, second: string): OverlapResult => {
  const firstWords = first.trim().split(/\s+/);
  const secondWords = second.trim().split(/\s+/);

  if (firstWords.length === 0 || secondWords.length === 0) {
    return {
      wordsToKeepFromFirst: firstWords.length,
      wordsToSkipFromSecond: 0,
    };
  }

  if (findTruncatedPrefixOverlap(firstWords, secondWords)) {
    // Drop the truncated word from first, use all of second
    return {
      wordsToKeepFromFirst: firstWords.length - 1,
      wordsToSkipFromSecond: 0,
    };
  }

  const best = findBestOverlap(firstWords, secondWords);

  // Also check for overlap if we drop the last word (handles truncated/misheard last word)
  if (!best && firstWords.length >= 2) {
    const droppedWordMatch = findExactMatchAfterDroppingLastWord(
      firstWords,
      secondWords,
    );
    if (droppedWordMatch !== null) {
      return {
        wordsToKeepFromFirst: firstWords.length - 1,
        wordsToSkipFromSecond: droppedWordMatch,
      };
    }
  }

  if (!best) {
    // No overlap found - concatenate
    return {
      wordsToKeepFromFirst: firstWords.length,
      wordsToSkipFromSecond: 0,
    };
  }

  if (best.isExact) {
    // Exact match: keep all of first (preserving its formatting), skip overlap from second
    return {
      wordsToKeepFromFirst: firstWords.length,
      wordsToSkipFromSecond: best.j,
    };
  }

  // Fuzzy match: drop the overlapping portion from first, use second's version
  // This handles contractions, hyphens, and truncated words
  return {
    wordsToKeepFromFirst: firstWords.length - best.i,
    wordsToSkipFromSecond: 0,
  };
};

/**
 * Merges two transcriptions by finding overlap using fuzzy string matching.
 * Handles contractions, hyphens, punctuation differences, and minor errors.
 */
const mergeTwoTranscriptions = (first: string, second: string): string => {
  const trimmedFirst = first.trim();
  const trimmedSecond = second.trim();

  if (!trimmedFirst) return trimmedSecond;
  if (!trimmedSecond) return trimmedFirst;

  const firstWords = trimmedFirst.split(/\s+/);
  const secondWords = trimmedSecond.split(/\s+/);

  const { wordsToKeepFromFirst, wordsToSkipFromSecond } = findOverlap(
    trimmedFirst,
    trimmedSecond,
  );

  // Build the merged result
  const firstPart = firstWords.slice(0, wordsToKeepFromFirst).join(" ");
  const secondPart = secondWords.slice(wordsToSkipFromSecond).join(" ");

  if (!firstPart) return trimmedSecond;
  if (!secondPart) return firstPart;

  return `${firstPart} ${secondPart}`;
};

/**
 * Merges multiple transcriptions from overlapping audio segments into a single string.
 *
 * The algorithm detects word overlap between consecutive transcriptions:
 * - If the end of one transcription matches the start of the next, they're merged at that point
 * - If no overlap is detected, transcriptions are concatenated with a space
 *
 * @example
 * // With overlap
 * mergeTranscriptions(["I want to eat", "to eat milk and cookies"])
 * // Returns: "I want to eat milk and cookies"
 *
 * @example
 * // Without overlap
 * mergeTranscriptions(["I want to", "eat milk"])
 * // Returns: "I want to eat milk"
 */
export const mergeTranscriptions = (transcriptions: string[]): string => {
  if (transcriptions.length === 0) return "";
  if (transcriptions.length === 1) return transcriptions[0];

  return transcriptions
    .slice(1)
    .reduce(
      (merged, current) => mergeTwoTranscriptions(merged, current),
      transcriptions[0],
    );
};

/**
 * Splits audio samples into overlapping segments for transcription.
 *
 * @example
 * // With 4 second segments and 2 second overlap:
 * // Segment 1: 0-4 sec
 * // Segment 2: 2-6 sec
 * // Segment 3: 4-8 sec
 * // etc.
 */
export const splitAudioTranscription = (args: {
  sampleRate: number;
  samples: Float32Array;
  segmentDurationSec: number;
  overlapDurationSec: number;
}): Float32Array[] => {
  const { sampleRate, samples, segmentDurationSec, overlapDurationSec } = args;

  const segmentSamples = Math.floor(sampleRate * segmentDurationSec);
  const stepSamples = Math.floor(
    sampleRate * (segmentDurationSec - overlapDurationSec),
  );

  if (stepSamples <= 0) {
    throw new Error("Overlap duration must be less than segment duration");
  }

  if (samples.length <= segmentSamples) {
    return [samples];
  }

  const segments: Float32Array[] = [];

  for (let start = 0; start < samples.length; start += stepSamples) {
    const end = Math.min(start + segmentSamples, samples.length);
    segments.push(samples.slice(start, end));

    if (end === samples.length) {
      break;
    }
  }

  return segments;
};
