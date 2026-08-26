/**
 * Extracts the words a user corrected while editing a dictation result, so
 * mausVoice can learn them as glossary terms.
 *
 * The engine is intentionally conservative. It only learns a token when it is
 * new in the corrected text (it did not appear in the original), looks like a
 * proper noun (an initial capital letter), and is not already a dictionary
 * term. A large edit is treated as a rewrite and learns nothing.
 *
 * Tokens shorter than MIN_TERM_LENGTH are dropped: the two-letter floor
 * keeps single-letter noise like a stray "A" or "I" out of the dictionary
 * while still learning two-letter names such as "Jo".
 */

const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 40;
const MAX_LEARNED_TERMS = 5;
const MAX_EDIT_TOKENS = 8;

// Split into leading/trailing passes rather than a single alternation. The
// two anchored character classes can otherwise overlap on all-punctuation
// tokens, which makes the regex backtrack in super-linear time.
const LEADING_EDGE_PATTERN = /^[^\p{L}\p{N}'’-]+/u;
const TRAILING_EDGE_PATTERN = /[^\p{L}\p{N}'’-]+$/u;
const POSSESSIVE_SUFFIX_PATTERN = /['’]s$/iu;
const UPPERCASE_LETTER_PATTERN = /^\p{Lu}/u;
const LETTER_PATTERN = /\p{L}/u;

/**
 * Common English function words, auxiliaries, pronouns, contractions and
 * short connectors. Checked case-insensitively so a capitalized sentence
 * fragment like "The" is never learned.
 */
const COMMON_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "nor",
  "so",
  "yet",
  "for",
  "if",
  "then",
  "else",
  "than",
  "as",
  "at",
  "by",
  "in",
  "on",
  "of",
  "to",
  "from",
  "with",
  "without",
  "about",
  "into",
  "over",
  "under",
  "again",
  "once",
  "here",
  "there",
  "where",
  "when",
  "why",
  "how",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "this",
  "that",
  "these",
  "those",
  "not",
  "no",
  "yes",
  "all",
  "any",
  "some",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "such",
  "only",
  "own",
  "same",
  "very",
  "just",
  "too",
  "also",
  "even",
  "still",
  "while",
  "because",
  "though",
  "although",
  "until",
  "since",
  "before",
  "after",
  "between",
  "among",
  "against",
  "during",
  "through",
  "above",
  "below",
  "behind",
  "beside",
  "near",
  "off",
  "out",
  "up",
  "down",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "mine",
  "yours",
  "hers",
  "ours",
  "theirs",
  "myself",
  "yourself",
  "himself",
  "herself",
  "itself",
  "ourselves",
  "yourselves",
  "themselves",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "having",
  "do",
  "does",
  "did",
  "doing",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "ought",
  "i'm",
  "im",
  "you're",
  "youre",
  "he's",
  "she's",
  "it's",
  "we're",
  "they're",
  "theyre",
  "i've",
  "ive",
  "you've",
  "youve",
  "we've",
  "they've",
  "theyve",
  "don't",
  "dont",
  "doesn't",
  "doesnt",
  "didn't",
  "didnt",
  "can't",
  "cant",
  "cannot",
  "won't",
  "wont",
  "wouldn't",
  "wouldnt",
  "couldn't",
  "couldnt",
  "shouldn't",
  "shouldnt",
  "isn't",
  "isnt",
  "aren't",
  "arent",
  "wasn't",
  "wasnt",
  "weren't",
  "werent",
  "haven't",
  "havent",
  "hasn't",
  "hasnt",
  "hadn't",
  "hadnt",
  "that's",
  "thats",
  "what's",
  "whats",
  "there's",
  "theres",
  "here's",
  "heres",
]);

export type AutoLearnTermsResult = {
  /** Terms to add as glossary entries, in the casing the user typed. */
  learnedTerms: string[];
};

/**
 * Splits text into comparable word tokens: surrounding punctuation stripped,
 * a trailing possessive "'s" removed, empty tokens dropped.
 */
export const tokenizeForComparison = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((raw) =>
      raw
        .replace(LEADING_EDGE_PATTERN, "")
        .replace(TRAILING_EDGE_PATTERN, "")
        .replace(POSSESSIVE_SUFFIX_PATTERN, ""),
    )
    .filter((token) => token.length > 0);

const toTokenCounts = (tokens: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

/**
 * Tokens present in `corrected` but not in `original`, as a case-insensitive
 * multiset difference. Original token casing is preserved.
 */
export const computeAddedTokens = (
  original: string,
  corrected: string,
): string[] => {
  const originalCounts = toTokenCounts(tokenizeForComparison(original));
  const added: string[] = [];

  for (const token of tokenizeForComparison(corrected)) {
    const key = token.toLowerCase();
    const remaining = originalCounts.get(key) ?? 0;
    if (remaining > 0) {
      originalCounts.set(key, remaining - 1);
    } else {
      added.push(token);
    }
  }

  return added;
};

/**
 * Tokens present in `original` but not in `corrected`, as a case-insensitive
 * multiset difference. Used to confirm an edit was a replacement rather than
 * a pure insertion.
 */
export const computeRemovedTokens = (
  original: string,
  corrected: string,
): string[] => computeAddedTokens(corrected, original);

const isCommonWord = (word: string): boolean =>
  COMMON_WORDS.has(word.toLowerCase());

const isLearnableProperNoun = (token: string): boolean => {
  if (!LETTER_PATTERN.test(token)) {
    return false;
  }

  if (token.length < MIN_TERM_LENGTH || token.length > MAX_TERM_LENGTH) {
    return false;
  }

  if (isCommonWord(token)) {
    return false;
  }

  // Only learn proper nouns, signalled by an initial capital letter. This
  // deliberately skips corrections of ordinary lowercase words.
  return UPPERCASE_LETTER_PATTERN.test(token);
};

/**
 * Filters candidate tokens down to the learnable proper nouns, skipping
 * existing dictionary terms and duplicates, capped at MAX_LEARNED_TERMS.
 */
export const collectLearnableTerms = (
  candidates: string[],
  existingTerms: string[],
): string[] => {
  const existing = new Set(
    existingTerms.map((term) => term.trim().toLowerCase()).filter(Boolean),
  );

  const learnedTerms: string[] = [];
  const seen = new Set<string>();

  for (const token of candidates) {
    if (learnedTerms.length >= MAX_LEARNED_TERMS) {
      break;
    }

    if (!isLearnableProperNoun(token)) {
      continue;
    }

    const lower = token.toLowerCase();
    if (existing.has(lower) || seen.has(lower)) {
      continue;
    }

    seen.add(lower);
    learnedTerms.push(token);
  }

  return learnedTerms;
};

export const extractAutoLearnTerms = (args: {
  original: string;
  corrected: string;
  existingTerms: string[];
}): AutoLearnTermsResult => {
  const { original, corrected, existingTerms } = args;
  const added = computeAddedTokens(original, corrected);

  // A correction touches a handful of tokens. A long list of added tokens
  // means the user rewrote the text, so learn nothing.
  if (added.length === 0 || added.length > MAX_EDIT_TOKENS) {
    return { learnedTerms: [] };
  }

  return { learnedTerms: collectLearnableTerms(added, existingTerms) };
};
