/**
 * Spoken-form to written-form conversion for the local styles.
 *
 * The API style prompt asks the model to "convert spoken dates, times, and
 * numbers into their proper numerical forms". The local path had no equivalent,
 * so a short dictation that routed locally wrote "two hundred and fifty
 * thousand dollars" where the provider wrote "$250,000". This module closes
 * that gap with a deterministic, reversible-by-reading pass over the text.
 *
 * Every rule is written to leave text alone when it is unsure:
 * - A phrase is only converted when every word in it is a known number word and
 *   the sequence is well formed, so "nineteen eighty four" and "twenty twenty"
 *   (years to a reader, invalid cardinals to a parser) stay as words.
 * - A single small number word is never converted on its own. "I need one" and
 *   "chapter five" keep their words; "thirty" and "one hundred" become digits,
 *   because those are quantities in every reading that reaches this pass.
 * - The article in "a hundred" is consumed with the number, because "a 100" is
 *   not written English; it stays when the currency name is attributive, so
 *   "a five dollar bill" reads "a $5 bill".
 * - A run after "point" or "dot" is the tail of a decimal this pass does not
 *   write ("zero point five percent"), and a scale word on its own in front of
 *   an attributive currency name is not a quantity ("the million dollar
 *   question"), so both keep the words the speaker used.
 *
 * Only English number words are handled. Every other input passes through
 * unchanged, which is what keeps the pass safe for the other dictation
 * languages the app supports.
 */

const SMALL_NUMBERS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1000,
  million: 1000000,
};

const ORDINAL_DAYS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  "twenty first": 21,
  "twenty second": 22,
  "twenty third": 23,
  "twenty fourth": 24,
  "twenty fifth": 25,
  "twenty sixth": 26,
  "twenty seventh": 27,
  "twenty eighth": 28,
  "twenty ninth": 29,
  thirtieth: 30,
  "thirty first": 31,
};

const MONTHS: Readonly<Record<string, string>> = {
  january: "January",
  february: "February",
  march: "March",
  april: "April",
  may: "May",
  june: "June",
  july: "July",
  august: "August",
  september: "September",
  october: "October",
  november: "November",
  december: "December",
};

/**
 * Currency names whose singular form is attributive in front of a noun ("dollar
 * bill", "euro coin"). A plural name, or a singular one at the end of its
 * phrase, is a unit.
 */
const SINGULAR_CURRENCY_UNITS: ReadonlySet<string> = new Set([
  "dollar",
  "buck",
  "euro",
  "pound",
]);

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  dollar: "$",
  dollars: "$",
  buck: "$",
  bucks: "$",
  euro: "€",
  euros: "€",
  pound: "£",
  pounds: "£",
};

const NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(SMALL_NUMBERS),
  ...Object.keys(TENS),
  ...Object.keys(SCALES),
]);

const ORDINAL_WORD_SOURCE = Object.keys(ORDINAL_DAYS)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/ /g, String.raw`[-\s]`))
  .join("|");

const MONTH_SOURCE = Object.keys(MONTHS).join("|");

/**
 * Months that are ordinary English words as well ("may", "march", "august").
 * The month-first shape skips them, because "we march first thing" and "you may
 * second guess that" are sentences, not dates. The "third of may" shape keeps
 * all twelve: an ordinal in front of the month word rules the other readings
 * out.
 */
const UNAMBIGUOUS_MONTH_SOURCE = Object.keys(MONTHS)
  .filter((month) => !["may", "march", "august"].includes(month))
  .join("|");

const MERIDIEM_NORMALIZATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^a\.?\s?m\.?$/i, "AM"],
  [/^p\.?\s?m\.?$/i, "PM"],
];

const normalizeMeridiem = (word: string): string | null => {
  const normalized = word.replace(/\./g, "").replace(/\s+/g, "");
  for (const [pattern, replacement] of MERIDIEM_NORMALIZATIONS) {
    if (pattern.test(normalized)) return replacement;
  }
  return null;
};

const isNumberWord = (word: string): boolean =>
  NUMBER_WORDS.has(word.toLowerCase());

const splitWordParts = (word: string): string[] => word.split("-");

/** True when a whitespace-delimited token is made only of number words. */
const isNumberToken = (word: string): boolean => {
  const parts = splitWordParts(word);
  return parts.length > 0 && parts.every(isNumberWord);
};

/** "and" joins a scale to its remainder, and is never a run on its own. */
const isJoiningToken = (word: string): boolean => word.toLowerCase() === "and";

const formatCardinal = (value: number): string =>
  value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

type CardinalParse = {
  value: number;
  /** Words consumed, so a caller can replace exactly the span that parsed. */
  words: string[];
};

/**
 * Parses a run of number words, or null when the run is not a well-formed
 * cardinal.
 *
 * The rejection rules are the year guard: a teen followed by a tens word
 * ("nineteen eighty"), a tens followed by another tens ("twenty twenty"), and
 * two single digits in a row ("one two") all read as years or as separate
 * numbers, and converting them would write a number the speaker did not say.
 */
const parseCardinal = (words: readonly string[]): CardinalParse | null => {
  if (words.length === 0) return null;
  let value = 0;
  let current = 0;
  let sawScale = false;
  let previous: "small" | "tens" | "scale" | null = null;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index].toLowerCase();

    if (word === "and") {
      // "and" only ever joins a scale to its remainder and never ends a run.
      if (!sawScale || index === 0 || index === words.length - 1) return null;
      continue;
    }

    const small = SMALL_NUMBERS[word];
    if (small !== undefined) {
      if (previous === "small") return null;
      if (previous === "tens" && small >= 10) return null;
      current += small;
      previous = "small";
      continue;
    }

    const tens = TENS[word];
    if (tens !== undefined) {
      if (previous === "tens") return null;
      // A small word before a tens word is two numbers, not one: "nineteen
      // eighty four" is a year and "three thirty" is a time, so neither is
      // written as the sum this parser would otherwise produce.
      if (previous === "small") return null;
      current += tens;
      previous = "tens";
      continue;
    }

    const scale = SCALES[word];
    if (scale === undefined) return null;
    if (scale === 100) {
      current = (current === 0 ? 1 : current) * 100;
    } else {
      value += (current === 0 ? 1 : current) * scale;
      current = 0;
    }
    sawScale = true;
    previous = "scale";
  }

  return { value: value + current, words: [...words] };
};

/** A bare cardinal converts unless it is a single small number word. */
const isConvertibleBareCardinal = (parse: CardinalParse): boolean => {
  if (parse.words.length === 1) {
    return parse.value >= 20;
  }
  return true;
};

type Segment = { text: string; isSpace: boolean };

const segmentText = (text: string): Segment[] =>
  text
    .split(/(\s+)/)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, isSpace: /^\s+$/.test(part) }));

/** Expands "twenty-three" into its two words while keeping its segments. */
const numberWordsOf = (text: string): string[] =>
  text.split("-").filter((part) => part.length > 0);

/** Sentence punctuation that can ride on the last word of a number. */
const TRAILING_PUNCTUATION_RE = /[.,!?;:]+$/;

/** Punctuation that ends the number run it sits on, unlike a comma. */
const SENTENCE_BOUNDARY_RE = /[.!?;:]+$/;

/**
 * The word inside a token, with the punctuation the sentence put there removed.
 * A number at the end of a dictation carries its full stop on the last word
 * ("we ordered twenty three."), so testing the token without stripping it read
 * only "twenty" and wrote "20 three".
 */
const numberTokenText = (text: string): string =>
  text.replace(TRAILING_PUNCTUATION_RE, "");

/** Whether a single word is one of the number words this pass understands. */
export const isSpokenNumberWord = (word: string): boolean =>
  NUMBER_WORDS.has(word.toLowerCase());

const applyTimeRules = (text: string): string => {
  let out = text;

  // "quarter past three" / "half past three" / "quarter to three".
  out = out.replace(
    /\b(quarter|half)\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
    (match, part: string, hour: string) => {
      const parsed = SMALL_NUMBERS[hour.toLowerCase()];
      if (parsed === undefined) return match;
      return `${parsed}:${part.toLowerCase() === "half" ? "30" : "15"}`;
    },
  );
  out = out.replace(
    /\bquarter\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
    (match, hour: string) => {
      const parsed = SMALL_NUMBERS[hour.toLowerCase()];
      if (parsed === undefined) return match;
      return `${parsed === 1 ? 12 : parsed - 1}:45`;
    },
  );

  // "three to five pm" reads as a range of clock times.
  out = out.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+to\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(a\.?\s?m\.?|p\.?\s?m\.?)\b/gi,
    (match, from: string, to: string, tail: string) => {
      const parsedFrom = SMALL_NUMBERS[from.toLowerCase()];
      const parsedTo = SMALL_NUMBERS[to.toLowerCase()];
      const meridiem = normalizeMeridiem(tail);
      if (
        parsedFrom === undefined ||
        parsedTo === undefined ||
        meridiem === null
      ) {
        return match;
      }
      return `${parsedFrom} to ${parsedTo} ${meridiem}`;
    },
  );

  // "three thirty pm", "three oh five p.m.", "nine am", "twelve o'clock".
  out = out.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+((?:oh|o)?\s?(?:twenty|thirty|forty|fifty)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|(?:oh|o)\s+(?:one|two|three|four|five|six|seven|eight|nine)))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|o'clock)\b/gi,
    (match, hour: string, minute: string | undefined, tail: string) => {
      const parsedHour = SMALL_NUMBERS[hour.toLowerCase()];
      if (parsedHour === undefined) return match;

      const meridiem = normalizeMeridiem(tail);
      if (meridiem === null) {
        // "o'clock" with no minute reads as the top of the hour.
        if (!minute) return `${parsedHour}:00`;
        const parsedMinute = parseMinuteWords(minute);
        if (parsedMinute === null) return match;
        return `${parsedHour}:${parsedMinute.toString().padStart(2, "0")}`;
      }

      if (!minute) return `${parsedHour} ${meridiem}`;
      const parsedMinute = parseMinuteWords(minute);
      if (parsedMinute === null) return match;
      return `${parsedHour}:${parsedMinute
        .toString()
        .padStart(2, "0")} ${meridiem}`;
    },
  );

  // "at three thirty" / "around eleven forty five": a clock time is only read
  // from a bare hour and minute when a time preposition sets it up.
  out = out.replace(
    /\b(at|by|around|about|from|until|before|after)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+(?:oh|o)\s+(one|two|three|four|five|six|seven|eight|nine)|\s+((?:twenty|thirty|forty|fifty)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?))\b/gi,
    (
      match,
      cue: string,
      hour: string,
      ohMinute: string | undefined,
      minute: string | undefined,
    ) => {
      const parsedHour = SMALL_NUMBERS[hour.toLowerCase()];
      if (parsedHour === undefined) return match;
      const minuteText = ohMinute ?? minute;
      if (!minuteText) return match;
      const parsedMinute = parseMinuteWords(
        ohMinute ? `o ${ohMinute}` : minuteText,
      );
      if (parsedMinute === null) return match;
      return `${cue} ${parsedHour}:${parsedMinute.toString().padStart(2, "0")}`;
    },
  );

  return out;
};

/** Minutes use their own parser: "thirty" is 30, "twenty three" is 23. */
const parseMinuteWords = (text: string): number | null => {
  const words = numberWordsOf(text.trim().replace(/\s+/g, "-")).filter(
    (word) => word.length > 0,
  );
  const lowered = words.map((word) => word.toLowerCase());
  const [first, ...rest] = lowered;

  if (first === "o" || first === "oh") {
    if (rest.length !== 1) return null;
    const value = SMALL_NUMBERS[rest[0]];
    return value === undefined || value > 9 ? null : value;
  }

  const tens = TENS[first];
  if (tens === undefined) return null;
  if (rest.length === 0) return tens;
  if (rest.length !== 1) return null;
  const unit = SMALL_NUMBERS[rest[0]];
  if (unit === undefined || unit > 9) return null;
  return tens + unit;
};

const applyDateRules = (text: string): string => {
  let out = text.replace(
    new RegExp(
      String.raw`\b(?:the\s+)?(${ORDINAL_WORD_SOURCE})\s+of\s+(${MONTH_SOURCE})\b`,
      "gi",
    ),
    (match, day: string, month: string) => {
      const parsed = ORDINAL_DAYS[day.toLowerCase().replace(/[-\s]+/g, " ")];
      const canonical = MONTHS[month.toLowerCase()];
      if (parsed === undefined || !canonical) return match;
      return `${canonical} ${parsed}`;
    },
  );

  out = out.replace(
    new RegExp(
      String.raw`\b(${UNAMBIGUOUS_MONTH_SOURCE})\s+(${ORDINAL_WORD_SOURCE})\b`,
      "gi",
    ),
    (match, month: string, day: string) => {
      const parsed = ORDINAL_DAYS[day.toLowerCase().replace(/[-\s]+/g, " ")];
      const canonical = MONTHS[month.toLowerCase()];
      if (parsed === undefined || !canonical) return match;
      return `${canonical} ${parsed}`;
    },
  );

  return out;
};

/**
 * Converts every run of number words, with the currency or percent word that
 * follows a run folded into the number it belongs to.
 *
 * A run is consumed as a unit even when it does not convert, so the pieces of a
 * rejected phrase ("nineteen eighty four") cannot be re-read as smaller
 * convertible ones ("eighty four").
 */
const applyCardinalRules = (text: string): string => {
  const segments = segmentText(text);
  const output: string[] = [];
  let index = 0;

  const runText = (from: number, to: number): string =>
    segments
      .slice(from, to + 1)
      .map((segment) => segment.text)
      .join("");

  /**
   * The word that ends the token before this segment, when the two are separate
   * tokens. Used to recognise the "point" a decimal is built on.
   */
  const wordBefore = (from: number): string => {
    const gap = segments[from - 1];
    const word = segments[from - 2];
    if (!gap?.isSpace || !word || word.isSpace) return "";
    return numberTokenText(word.text).toLowerCase();
  };

  while (index < segments.length) {
    const segment = segments[index];

    if (segment.isSpace || !isNumberToken(numberTokenText(segment.text))) {
      output.push(segment.text);
      index += 1;
      continue;
    }

    const words: string[] = [];
    let cursor = index;
    let lastTokenIndex = index;
    while (cursor < segments.length) {
      const candidate = segments[cursor];
      if (candidate.isSpace) {
        cursor += 1;
        continue;
      }
      const candidateText = numberTokenText(candidate.text);
      if (isJoiningToken(candidateText)) {
        // Only a scale word before it makes "and" part of one number.
        const joinsScale = words.some(
          (word) => SCALES[word.toLowerCase()] !== undefined,
        );
        if (!joinsScale) break;
        words.push("and");
        lastTokenIndex = cursor;
        cursor += 1;
        continue;
      }
      if (!isNumberToken(candidateText)) break;
      words.push(...numberWordsOf(candidateText));
      lastTokenIndex = cursor;
      cursor += 1;
      // Sentence and clause punctuation ends the run: "one thousand. Twenty
      // five arrived" is two statements, not 1,025.
      if (SENTENCE_BOUNDARY_RE.test(candidate.text)) break;
    }

    const nextIndex = lastTokenIndex + 1;
    const parsedRun = parseCardinal(words);
    // A run after "point" or "dot" is the tail of a decimal this pass does not
    // write, so it keeps the words the speaker used.
    const followsDecimalWord = ["point", "dot"].includes(wordBefore(index));

    // A currency or percent word directly after the run belongs to it.
    let currencyPrefix = "";
    let percentSuffix = "";
    let trailingIndex = -1;
    let trailingPunctuation = "";
    let attributiveUnit = false;
    const separator = segments[nextIndex];
    if (separator?.isSpace) {
      const wordSegment = segments[nextIndex + 1];
      const word = wordSegment && !wordSegment.isSpace ? wordSegment.text : "";
      const lowered = word.toLowerCase().replace(/[.,!?;:]+$/, "");
      const punctuation = word.slice(lowered.length);
      const afterUnit = segments[nextIndex + 2];
      const afterUnitWord = segments[nextIndex + 3];
      attributiveUnit =
        SINGULAR_CURRENCY_UNITS.has(lowered) &&
        Boolean(afterUnit?.isSpace && afterUnitWord && !afterUnitWord.isSpace);
      if (CURRENCY_SYMBOLS[lowered]) {
        currencyPrefix = CURRENCY_SYMBOLS[lowered];
        trailingPunctuation = punctuation;
        trailingIndex = nextIndex + 1;
      } else if (lowered === "percent") {
        percentSuffix = "%";
        trailingPunctuation = punctuation;
        trailingIndex = nextIndex + 1;
      } else if (lowered === "per") {
        // "per cent" / "per cents", where the space is part of the unit.
        const cents = segments[nextIndex + 3];
        const centsWord =
          cents && !cents.isSpace
            ? cents.text.toLowerCase().replace(/[.,!?;:]+$/, "")
            : "";
        if (centsWord === "cent" || centsWord === "cents") {
          percentSuffix = "%";
          trailingIndex = nextIndex + 3;
        }
      }
    }

    const hasUnit = currencyPrefix.length > 0 || percentSuffix.length > 0;
    const hasExplicitQuantity = words.some(
      (word) =>
        SMALL_NUMBERS[word.toLowerCase()] !== undefined ||
        TENS[word.toLowerCase()] !== undefined,
    );
    const convertible =
      parsedRun !== null &&
      !followsDecimalWord &&
      // A scale word on its own in front of an attributive currency name is not
      // a quantity: "the million dollar question" names a question.
      !(attributiveUnit && !hasExplicitQuantity) &&
      (hasUnit || isConvertibleBareCardinal(parsedRun));

    if (!convertible) {
      output.push(runText(index, lastTokenIndex));
      index = nextIndex;
      continue;
    }

    const parsed = parsedRun as CardinalParse;
    // "a hundred" and "a twenty" read as quantities once the number is written,
    // so the article that was already emitted goes with it. "a one" never
    // reaches here: a bare single small number does not convert.
    const previous = output[output.length - 1];
    const beforePrevious = output[output.length - 2];
    if (
      !attributiveUnit &&
      beforePrevious !== undefined &&
      previous !== undefined &&
      /^(?:a|an)$/i.test(beforePrevious) &&
      /^\s+$/.test(previous)
    ) {
      output.pop();
      output.pop();
    }
    output.push(
      `${currencyPrefix}${formatCardinal(parsed.value)}${percentSuffix}`,
    );
    if (trailingIndex > 0) {
      output.push(trailingPunctuation);
    } else {
      // The number test stripped the punctuation that ended the sentence on the
      // last word of the run, so it is put back after the digits.
      output.push(
        segments[lastTokenIndex].text.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "",
      );
    }
    index = trailingIndex > 0 ? trailingIndex + 1 : nextIndex;
  }

  return output.join("");
};

/**
 * Rewrites spoken numbers, times, dates, currency and percentages into the
 * forms the API styles write. Text with none of those shapes is returned
 * unchanged, character for character.
 */
export const normalizeSpokenForms = (text: string): string => {
  if (!text || !/[a-z]/i.test(text)) return text;
  try {
    let out = applyTimeRules(text);
    out = applyDateRules(out);
    out = applyCardinalRules(out);
    return out;
  } catch {
    // A rewrite that fails must never cost the speaker their text.
    return text;
  }
};
