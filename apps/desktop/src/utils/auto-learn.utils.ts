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

// Trimming runs as a two-pointer scan over single code-point tests. A quantified
// character class anchored only at one end (for example /[^...]+$/u) makes the
// engine retry from every offset, which is super-linear on all-punctuation
// tokens. Array.from splits on code points rather than UTF-16 code units, so a
// supplementary-plane letter is never split into surrogates that each look like
// an edge character.
const TOKEN_EDGE_CHARACTER = /[^\p{L}\p{N}'’-]/u;
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
  // Politeness, greetings and connectives that survive the common-word list
  // above only because they are rarely function words: they still must never
  // be learned just because a correction capitalized them.
  "please",
  "thank",
  "thanks",
  "sorry",
  "excuse",
  "pardon",
  "welcome",
  "hello",
  "hi",
  "hey",
  "dear",
  "regards",
  "sincerely",
  "faithfully",
  "greetings",
  "congrats",
  "congratulations",
  "goodbye",
  "bye",
  "let",
  "lets",
  "ok",
  "okay",
  "maybe",
  "perhaps",
  "anyway",
  "anyways",
  "sure",
  "fine",
  "alright",
  "wow",
  "awesome",
  // Weekdays and months: ordinary words that users routinely capitalize at
  // sentence starts, never worth a dictionary hint.
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "tues",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  // Stopgap for non-English languages: the most frequent capitalized common
  // nouns, pronouns and politeness words for the languages the app ships.
  // German capitalizes every noun, so without this list any inserted or
  // case-corrected noun would be learned. The durable fix is per-language
  // stop lists selected by the dictation language.
  "wir",
  "ihnen",
  "euch",
  "danke",
  "bitte",
  "entschuldigung",
  "herr",
  "stadt",
  "haus",
  "zeit",
  "tag",
  "woche",
  "monat",
  "jahr",
  "mann",
  "frau",
  "kind",
  "kinder",
  "name",
  "frage",
  "antwort",
  "arbeit",
  "geld",
  "welt",
  "leben",
  "liebe",
  "nacht",
  "morgen",
  "abend",
  "stunde",
  "straße",
  "strasse",
  "platz",
  "land",
  "wasser",
  "nous",
  "vous",
  "merci",
  "bonjour",
  "bonsoir",
  "monsieur",
  "madame",
  "salut",
  "bienvenue",
  "usted",
  "ustedes",
  "gracias",
  "hola",
  "buenos",
  "buenas",
  "señor",
  "señora",
  "señorita",
  "favor",
  "bienvenido",
  "bienvenidos",
  "lei",
  "grazie",
  "buongiorno",
  "buonasera",
  "prego",
  "signore",
  "signora",
  "benvenuto",
  "benvenuta",
  "você",
  "vocês",
  "obrigado",
  "obrigada",
  "olá",
  "senhor",
  "senhora",
  "bom",
  "boa",
  "alstublieft",
  "alstjeblieft",
  "bedankt",
  "hallo",
  "meneer",
  "mevrouw",
]);

export type AutoLearnTermsResult = {
  /** Terms to add as glossary entries, in the casing the user typed. */
  learnedTerms: string[];
};

const trimTokenEdges = (raw: string): string => {
  const codePoints = Array.from(raw);
  let start = 0;
  let end = codePoints.length;

  while (start < end && TOKEN_EDGE_CHARACTER.test(codePoints[start]!)) {
    start += 1;
  }
  while (end > start && TOKEN_EDGE_CHARACTER.test(codePoints[end - 1]!)) {
    end -= 1;
  }

  return codePoints.slice(start, end).join("");
};

/**
 * Splits text into comparable word tokens: surrounding punctuation stripped,
 * a trailing possessive "'s" removed, empty tokens dropped.
 */
export const tokenizeForComparison = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((raw) => trimTokenEdges(raw).replace(POSSESSIVE_SUFFIX_PATTERN, ""))
    .filter((token) => token.length > 0);

const toTokenCounts = (tokens: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const key = token.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const toExactTokenCounts = (tokens: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
};

/**
 * Tokens present in `corrected` but not in `original`, as a case-insensitive
 * multiset difference. Corrected token casing is preserved.
 *
 * A token that matches an original token case-insensitively but not in its
 * exact form is a casing correction ("sonia" → "Sonia") and is surfaced as an
 * added token too: recognizers routinely emit proper nouns lowercased, so
 * capitalization is one of the most common corrections a user makes. The
 * proper-noun and common-word filters downstream still decide learnability.
 */
export const computeAddedTokens = (
  original: string,
  corrected: string,
): string[] => {
  const originalTokens = tokenizeForComparison(original);
  const originalCounts = toTokenCounts(originalTokens);
  const originalExactCounts = toExactTokenCounts(originalTokens);
  const added: string[] = [];

  for (const token of tokenizeForComparison(corrected)) {
    const key = token.toLowerCase();
    const remaining = originalCounts.get(key) ?? 0;
    if (remaining > 0) {
      originalCounts.set(key, remaining - 1);
      const exactRemaining = originalExactCounts.get(token) ?? 0;
      if (exactRemaining > 0) {
        originalExactCounts.set(token, exactRemaining - 1);
      } else {
        added.push(token);
      }
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
): string[] => {
  // A removal is an addition viewed from the other side, so the two strings
  // are swapped deliberately here.
  const [from, to] = [corrected, original];
  return computeAddedTokens(from, to);
};

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
