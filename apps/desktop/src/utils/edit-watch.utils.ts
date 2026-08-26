import {
  collectLearnableTerms,
  computeAddedTokens,
  computeRemovedTokens,
  tokenizeForComparison,
} from "./auto-learn.utils";

const MAX_EDIT_TOKENS = 8;

/**
 * Locates the window of `fieldTokens` that best matches `insertedTokens` by
 * positional (case-insensitive) token equality. The inserted text is expected
 * to survive in the field nearly verbatim, with at most a couple of edited
 * tokens, so the best-scoring equal-length window is the dictation region.
 */
const locateInsertedWindow = (
  insertedTokens: string[],
  fieldTokens: string[],
): string[] => {
  const n = insertedTokens.length;
  const m = fieldTokens.length;
  if (n === 0) {
    return [];
  }

  // The field is the transcript (or shorter); diff it directly.
  if (m <= n) {
    return fieldTokens;
  }

  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start + n <= m; start++) {
    let score = 0;
    for (let i = 0; i < n; i++) {
      if (
        fieldTokens[start + i].toLowerCase() === insertedTokens[i].toLowerCase()
      ) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return fieldTokens.slice(bestStart, bestStart + n);
};

/**
 * Compares the text a dictation inserted with the current focused-field text
 * and returns proper-noun terms that look like the user's correction.
 *
 * A correction is a small replacement: at least one token changed, both the
 * added and removed token counts stay small, and at least one inserted token
 * still survives in the field (so an unrelated focused field never matches).
 */
export const findEditCorrections = (args: {
  insertedText: string;
  fieldText: string;
  existingTerms: string[];
}): string[] => {
  const { insertedText, fieldText, existingTerms } = args;
  const insertedTokens = tokenizeForComparison(insertedText);
  if (insertedTokens.length === 0) {
    return [];
  }

  const fieldTokens = tokenizeForComparison(fieldText);
  const windowTokens = locateInsertedWindow(insertedTokens, fieldTokens);
  const windowText = windowTokens.join(" ");

  const added = computeAddedTokens(insertedText, windowText);
  const removed = computeRemovedTokens(insertedText, windowText);
  // Symmetric multiset difference: tokens present in the inserted dictation
  // but not in the focused field (i.e. what the user replaced away from).

  if (added.length === 0 || added.length > MAX_EDIT_TOKENS) {
    return [];
  }

  // A pure insertion (nothing removed) is not a correction, and neither is a
  // region that shares nothing with the inserted text. The zero-overlap
  // rejection only applies to multi-token dictations: a single-word dictation
  // that the user fully replaced ("theory" -> "Three") is exactly the case we
  // want to learn, and is indistinguishable from an unrelated field.
  if (removed.length === 0 || removed.length > MAX_EDIT_TOKENS) {
    return [];
  }

  if (insertedTokens.length > 1 && removed.length >= insertedTokens.length) {
    return [];
  }

  return collectLearnableTerms(added, existingTerms);
};
