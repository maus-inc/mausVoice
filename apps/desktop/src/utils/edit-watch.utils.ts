import {
  collectLearnableTerms,
  computeAddedTokens,
  computeRemovedTokens,
  tokenizeForComparison,
} from "./auto-learn.utils";

const MAX_EDIT_TOKENS = 8;

const SMART_APOSTROPHE_PATTERN = /[\u2018\u2019]/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * Collapses the differences a target app can introduce between the text
 * mausVoice inserted and the text the accessibility API reports back: smart
 * typography turning straight quotes curly, and reflowed whitespace.
 */
const normalizeForContainment = (text: string): string =>
  text
    .replace(SMART_APOSTROPHE_PATTERN, "'")
    .replace(WHITESPACE_PATTERN, " ")
    .trim()
    .toLowerCase();

/**
 * Confirms a field snapshot still holds the dictated text, so the watcher only
 * ever diffs the field it actually dictated into.
 *
 * Without this the watcher would diff whatever field happens to be focused
 * later in the 90 second window, and every word of that unrelated field would
 * look like a correction. It also rejects a snapshot taken before the paste
 * landed or after the user already corrected the dictation, because neither
 * describes the moment the dictation arrived.
 */
export const baselineHoldsDictation = (
  insertedText: string,
  baselineText: string,
): boolean => {
  const inserted = normalizeForContainment(insertedText);
  if (!inserted) {
    return false;
  }
  return normalizeForContainment(baselineText).includes(inserted);
};

/**
 * Returns the proper-noun terms the user corrected in the focused field.
 *
 * The diff runs against the field as it read right after the dictation landed,
 * not against the dictation itself. Document text that was already on screen is
 * then on both sides of the diff and cancels out, so only what the user changed
 * can be proposed. Locating the dictation inside an arbitrary document and
 * diffing that instead let unrelated text be read as the correction.
 *
 * A correction is a small replacement: at least one token changed on each side,
 * both counts stay small, and fewer tokens were removed than were dictated.
 */
export const findEditCorrections = (args: {
  insertedText: string;
  baselineText: string;
  fieldText: string;
  existingTerms: string[];
}): string[] => {
  const { insertedText, baselineText, fieldText, existingTerms } = args;
  const insertedTokens = tokenizeForComparison(insertedText);
  if (insertedTokens.length === 0) {
    return [];
  }

  const added = computeAddedTokens(baselineText, fieldText);
  const removed = computeRemovedTokens(baselineText, fieldText);

  // A long list of added tokens means the user rewrote the text.
  if (added.length === 0 || added.length > MAX_EDIT_TOKENS) {
    return [];
  }

  // A pure insertion is the user adding their own words, not correcting the
  // dictation, and a long removal is a rewrite.
  if (removed.length === 0 || removed.length > MAX_EDIT_TOKENS) {
    return [];
  }

  // Replacing at least as much as was dictated is a rewrite. A single-word
  // dictation is exempt: "theory" -> "Three" is exactly the case worth
  // learning, and it necessarily removes the only dictated token.
  if (insertedTokens.length > 1 && removed.length >= insertedTokens.length) {
    return [];
  }

  return collectLearnableTerms(added, existingTerms);
};
