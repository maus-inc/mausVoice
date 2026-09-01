import { Nullable } from "@maus-inc/types";

export {
  KNOWN_SILENCE_HALLUCINATIONS,
  filterKnownSilenceHallucinations,
  isKnownSilenceHallucination,
} from "./hallucination.utils";

/**
 * Escapes regular expression metacharacters in `value` so it can be embedded
 * as a literal pattern. Use this whenever a user-supplied string (for example
 * a dictionary term's source value) is passed to `new RegExp`, `String.replace`
 * with a regex, or any other regex-accepting API. Without escaping, a term
 * like `C++` or `a.b` is interpreted as a regex pattern and either throws
 * or matches the wrong span.
 */
const REGEXP_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

export const escapeRegExp = (value: string): string =>
  value.replace(REGEXP_ESCAPE_PATTERN, String.raw`\$&`);

/**
 * Calculates the Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits (insertions,
 * deletions, or substitutions) required to change one string into another.
 */
export const editDistance = (a: string, b: string): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two rows instead of full matrix for space efficiency
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  // oxlint-disable-next-line no-new-array
  let currRow = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1]! + 1, // insertion
        prevRow[j]! + 1, // deletion
        prevRow[j - 1]! + cost, // substitution
      );
    }

    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length]!;
};

/**
 * Calculates the similarity between two strings as a ratio from 0 to 1.
 * Returns 1 for identical strings, 0 for completely different strings.
 * Based on Levenshtein edit distance.
 */
export const getStringSimilarity = (a: string, b: string): number => {
  if (a.length === 0 && b.length === 0) return 1;

  const maxLength = Math.max(a.length, b.length);
  const distance = editDistance(a, b);

  return (maxLength - distance) / maxLength;
};

export const getFirstAndLastName = (
  fullName: string,
): {
  firstName: Nullable<string>;
  lastName: Nullable<string>;
} => {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) {
    return { firstName: null, lastName: null };
  }

  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.at(-1) : null;
  return {
    firstName: firstName.trim() || null,
    lastName: lastName?.trim() || null,
  };
};

export const getInitials = (fullName: string): string => {
  const { firstName, lastName } = getFirstAndLastName(fullName);
  if (!firstName && !lastName) return "";
  if (firstName && !lastName) return firstName.charAt(0).toUpperCase();
  if (!firstName && lastName) return lastName.charAt(0).toUpperCase();
  return (
    (firstName ? firstName.charAt(0).toUpperCase() : "") +
    (lastName ? lastName.charAt(0).toUpperCase() : "")
  );
};

export type ReplacementRule = {
  sourceValue: string;
  destinationValue: string;
};

const SYMBOL_CONVERSIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bhashtag[,;:.!?]?\s+(\w)/gi, replacement: "#$1" },
  { pattern: /\bpound\s*sign[,;:.!?]?\s+(\w)/gi, replacement: "#$1" },
];

export const applySymbolConversions = (text: string): string => {
  let result = text;

  for (const { pattern, replacement } of SYMBOL_CONVERSIONS) {
    result = result.replace(pattern, replacement);
  }

  return result;
};

const SIMILARITY_THRESHOLD = 0.95;

const extractPunctuation = (
  word: string,
): {
  word: string;
  leadingPunctuation: string;
  trailingPunctuation: string;
} => {
  const leadingMatch = word.match(/^([^\p{L}\p{N}]*)/u);
  const leadingPunctuation = leadingMatch?.[1] ?? "";

  const afterLeading = word.slice(leadingPunctuation.length);

  const trailingMatch = afterLeading.match(/('s)?([^\p{L}\p{N}]*)$/iu);
  const possessiveSuffix = trailingMatch?.[1] ?? "";
  const trailingPunctuation = possessiveSuffix + (trailingMatch?.[2] ?? "");

  const wordOnly = afterLeading.slice(
    0,
    afterLeading.length - trailingPunctuation.length || undefined,
  );

  return { word: wordOnly, leadingPunctuation, trailingPunctuation };
};

export const sanitizeIndentation = (text: string): string => {
  return text
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ");

/**
 * Canonical form used to compare a rule's source against a candidate span:
 * internal whitespace collapsed, surrounding punctuation stripped.
 */
const normalizePhrase = (phrase: string): string =>
  extractPunctuation(collapseWhitespace(phrase.trim())).word;

const countWords = (phrase: string): number => {
  const trimmed = phrase.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
};

<<<<<<< HEAD
type PreparedRule = {
=======
type PreparedReplacementRule = {
>>>>>>> origin/fix/superfix-review-findings
  rule: ReplacementRule;
  source: string;
  wordCount: number;
};
<<<<<<< HEAD

const findBestMatchingRule = (
  preparedRules: PreparedRule[],
  normalizedCandidate: string,
  span: number,
): ReplacementRule | null => {
  let bestMatch: ReplacementRule | null = null;
  let bestSimilarity = 0;

  for (const prepared of preparedRules) {
    if (prepared.wordCount !== span) continue;

    const similarity = getStringSimilarity(
      normalizedCandidate,
      prepared.source,
    );
    if (similarity >= SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = prepared.rule;
    }
  }

  return bestMatch;
};

export const applyReplacements = (
  text: string,
  rules: ReplacementRule[],
): string => {
  if (rules.length === 0) return text;
=======
>>>>>>> origin/fix/superfix-review-findings

// Positions of the word segments; the odd indices in between are whitespace.
const findWordPositions = (segments: string[]): number[] => {
  const wordPositions: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment && !/^\s+$/.test(segment)) {
      wordPositions.push(i);
    }
  }
  return wordPositions;
};

<<<<<<< HEAD
  // Rules are matched as phrases, so a rule spans as many words as its source
  // does. Longer phrases are tried first so that "New York City" wins over a
  // "New York" rule at the same position.
  const preparedRules: PreparedRule[] = rules
=======
// Rules are matched as phrases, so a rule spans as many words as its source
// does. Longer phrases are tried first so that "New York City" wins over a
// "New York" rule at the same position.
const prepareReplacementRules = (
  rules: ReplacementRule[],
): PreparedReplacementRule[] =>
  rules
>>>>>>> origin/fix/superfix-review-findings
    .map((rule) => ({
      rule,
      source: normalizePhrase(rule.sourceValue).toLowerCase(),
      wordCount: countWords(rule.sourceValue),
    }))
    .filter((prepared) => prepared.source.length > 0);

const findBestRuleMatch = (
  preparedRules: PreparedReplacementRule[],
  span: number,
  normalizedCandidate: string,
): ReplacementRule | null => {
  let bestMatch: ReplacementRule | null = null;
  let bestSimilarity = 0;

  for (const prepared of preparedRules) {
    if (prepared.wordCount !== span) continue;

    const similarity = getStringSimilarity(
      normalizedCandidate,
      prepared.source,
    );
    if (similarity >= SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = prepared.rule;
    }
  }

  return bestMatch;
};

const appendUntil = (
  result: string[],
  segments: string[],
  from: number,
  until: number,
): void => {
  for (let i = from; i < until; i++) {
    result.push(segments[i]);
  }
};

const tryReplaceSpan = (
  preparedRules: PreparedReplacementRule[],
  segments: string[],
  wordPositions: number[],
  wordIndex: number,
  startSegment: number,
  span: number,
): { text: string; nextSegmentIndex: number } | null => {
  const endSegment = wordPositions[wordIndex + span - 1];
  const candidate = segments.slice(startSegment, endSegment + 1).join("");
  const { word, leadingPunctuation, trailingPunctuation } =
    extractPunctuation(candidate);
  if (!word) {
    return null;
  }

  const bestMatch = findBestRuleMatch(
    preparedRules,
    span,
    collapseWhitespace(word).toLowerCase(),
  );
  if (!bestMatch) {
    return null;
  }

  const { word: destinationWord } = extractPunctuation(
    bestMatch.destinationValue,
  );
  return {
    text: leadingPunctuation + destinationWord + trailingPunctuation,
    nextSegmentIndex: endSegment + 1,
  };
};

export const applyReplacements = (
  text: string,
  rules: ReplacementRule[],
): string => {
  if (rules.length === 0) return text;

  const segments = text.split(/(\s+)/);
  const wordPositions = findWordPositions(segments);
  const preparedRules = prepareReplacementRules(rules);

  if (preparedRules.length === 0) return text;

  const maxWordCount = Math.max(
    ...preparedRules.map((prepared) => prepared.wordCount),
  );
  const result: string[] = [];
  let segmentIndex = 0;
  let wordIndex = 0;

  while (wordIndex < wordPositions.length) {
    const startSegment = wordPositions[wordIndex];
    appendUntil(result, segments, segmentIndex, startSegment);
    const remainingWords = wordPositions.length - wordIndex;
    let matchedSpan = 0;

<<<<<<< HEAD
    for (
      let span = Math.min(maxWordCount, remainingWords);
      span >= 1 && !matched;
      span--
    ) {
      const endSegment = wordPositions[wordIndex + span - 1];
      const candidate = segments.slice(startSegment, endSegment + 1).join("");
      const { word, leadingPunctuation, trailingPunctuation } =
        extractPunctuation(candidate);

      if (!word) continue;

      const normalizedCandidate = collapseWhitespace(word).toLowerCase();
      const bestMatch = findBestMatchingRule(
        preparedRules,
        normalizedCandidate,
        span,
      );

      if (bestMatch) {
        const { word: destinationWord } = extractPunctuation(
          bestMatch.destinationValue,
        );
        result.push(leadingPunctuation + destinationWord + trailingPunctuation);
        segmentIndex = endSegment + 1;
        wordIndex += span;
        matched = true;
=======
    for (let span = Math.min(maxWordCount, remainingWords); span >= 1; span--) {
      const replacement = tryReplaceSpan(
        preparedRules,
        segments,
        wordPositions,
        wordIndex,
        startSegment,
        span,
      );
      if (replacement) {
        result.push(replacement.text);
        segmentIndex = replacement.nextSegmentIndex;
        matchedSpan = span;
        break;
>>>>>>> origin/fix/superfix-review-findings
      }
    }

    if (matchedSpan === 0) {
      result.push(segments[startSegment]);
      segmentIndex = startSegment + 1;
      wordIndex++;
    } else {
      wordIndex += matchedSpan;
    }
  }

  appendUntil(result, segments, segmentIndex, segments.length);
  return result.join("");
};
