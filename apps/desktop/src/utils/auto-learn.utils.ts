/**
 * Extracts the words a user corrected while editing a dictation result, so
 * mausVoice can learn them as glossary terms.
 *
 * The engine is intentionally conservative. It only learns a token when it is
 * new in the corrected text (it did not appear in the original), looks like a
 * proper noun (an initial capital letter), and is not already a dictionary
 * term. A large edit is treated as a rewrite and learns nothing.
 */

const MIN_TERM_LENGTH = 2;
const MAX_TERM_LENGTH = 40;
const MAX_LEARNED_TERMS = 5;
const MAX_EDIT_TOKENS = 8;

const EDGE_PUNCTUATION_PATTERN = /^[^\p{L}\p{N}'’-]+|[^\p{L}\p{N}'’-]+$/gu;
const POSSESSIVE_SUFFIX_PATTERN = /['’]s$/iu;
const UPPERCASE_LETTER_PATTERN = /^\p{Lu}/u;
const LETTER_PATTERN = /[\p{L}]/u;

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

const tokenize = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((raw) =>
      raw
        .replace(EDGE_PUNCTUATION_PATTERN, "")
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

const computeAddedTokens = (original: string, corrected: string): string[] => {
  const originalCounts = toTokenCounts(tokenize(original));
  const added: string[] = [];

  for (const token of tokenize(corrected)) {
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

const isCommonWord = (word: string): boolean =>
  COMMON_WORDS.has(word.toLowerCase());

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

  const existing = new Set(
    existingTerms.map((term) => term.trim().toLowerCase()).filter(Boolean),
  );

  const learnedTerms: string[] = [];
  const seen = new Set<string>();

  for (const token of added) {
    if (learnedTerms.length >= MAX_LEARNED_TERMS) {
      break;
    }

    if (!LETTER_PATTERN.test(token)) {
      continue;
    }

    if (token.length < MIN_TERM_LENGTH || token.length > MAX_TERM_LENGTH) {
      continue;
    }

    const lower = token.toLowerCase();
    if (isCommonWord(lower) || existing.has(lower) || seen.has(lower)) {
      continue;
    }

    // Only learn proper nouns, signalled by an initial capital letter. This
    // deliberately skips corrections of ordinary lowercase words.
    if (!UPPERCASE_LETTER_PATTERN.test(token)) {
      continue;
    }

    seen.add(lower);
    learnedTerms.push(token);
  }

  return { learnedTerms };
};
