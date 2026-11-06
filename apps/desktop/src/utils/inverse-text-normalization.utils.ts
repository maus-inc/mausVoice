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

type CardinalState = {
  value: number;
  current: number;
  sawScale: boolean;
  previous: "small" | "tens" | "scale" | null;
};

/** Adds one of the numbers below twenty, or refuses the run. */
const addSmallNumber = (state: CardinalState, small: number): boolean => {
  if (state.previous === "small") return false;
  if (state.previous === "tens" && small >= 10) return false;
  state.current += small;
  state.previous = "small";
  return true;
};

/**
 * Adds a tens word, or refuses the run.
 *
 * A small or tens word before a tens word is two numbers, not one: "nineteen
 * eighty four" is a year and "three thirty" is a time, so neither is written as
 * the sum this parser would otherwise produce.
 */
const addTensNumber = (state: CardinalState, tens: number): boolean => {
  if (state.previous === "small" || state.previous === "tens") return false;
  state.current += tens;
  state.previous = "tens";
  return true;
};

/** Adds a scale word, which carries what came before it up into the value. */
const addScaleNumber = (state: CardinalState, scale: number): void => {
  if (scale === 100) {
    state.current = (state.current === 0 ? 1 : state.current) * 100;
  } else {
    state.value += (state.current === 0 ? 1 : state.current) * scale;
    state.current = 0;
  }
  state.sawScale = true;
  state.previous = "scale";
};

/** Adds one word to the run, or refuses the run when the word does not fit. */
const addCardinalWord = (state: CardinalState, word: string): boolean => {
  const small = SMALL_NUMBERS[word];
  if (small !== undefined) return addSmallNumber(state, small);
  const tens = TENS[word];
  if (tens !== undefined) return addTensNumber(state, tens);
  const scale = SCALES[word];
  if (scale === undefined) return false;
  addScaleNumber(state, scale);
  return true;
};

/** "and" joins a scale to its remainder and never opens or ends a run. */
const isJoiningWord = (
  state: CardinalState,
  index: number,
  length: number,
): boolean => state.sawScale && index > 0 && index < length - 1;

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
  const state: CardinalState = {
    value: 0,
    current: 0,
    sawScale: false,
    previous: null,
  };

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index].toLowerCase();
    if (word === "and") {
      if (!isJoiningWord(state, index, words.length)) return null;
      continue;
    }
    if (!addCardinalWord(state, word)) return null;
  }

  return { value: state.value + state.current, words: [...words] };
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

/** A minute spelled as "oh five": the "oh" and one digit below ten. */
const spelledMinute = (rest: readonly string[]): number | null => {
  if (rest.length !== 1) return null;
  const value = SMALL_NUMBERS[rest[0]];
  return value === undefined || value > 9 ? null : value;
};

/** A minute spelled as "thirty", "forty five", or "twenty three". */
const tensMinute = (words: readonly string[]): number | null => {
  const [first, ...rest] = words;
  const tens = TENS[first];
  if (tens === undefined) return null;
  if (rest.length === 0) return tens;
  if (rest.length !== 1) return null;
  const unit = SMALL_NUMBERS[rest[0]];
  return unit === undefined || unit > 9 ? null : tens + unit;
};

/** Minutes use their own parser: "thirty" is 30, "twenty three" is 23. */
const parseMinuteWords = (text: string): number | null => {
  const words = numberWordsOf(text.trim().replace(/\s+/g, "-"))
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const [first, ...rest] = words;
  if (first === "o" || first === "oh") return spelledMinute(rest);
  return tensMinute(words);
};

/**
 * A written clock time, or null when the hour or minute cannot be read.
 *
 * "three thirty pm" and "nine am" carry a meridiem; "twelve o'clock" and a time
 * opening with a preposition carry none, and a bare hour is only written when
 * the text said it was a time.
 */
const formatClockTime = (
  hour: number,
  minuteWords: string | undefined,
  meridiem: string | null,
): string | null => {
  if (meridiem === null) {
    if (!minuteWords) return `${hour}:00`;
    const minute = parseMinuteWords(minuteWords);
    if (minute === null) return null;
    return `${hour}:${minute.toString().padStart(2, "0")}`;
  }
  if (!minuteWords) return `${hour} ${meridiem}`;
  const minute = parseMinuteWords(minuteWords);
  if (minute === null) return null;
  return `${hour}:${minute.toString().padStart(2, "0")} ${meridiem}`;
};

/** "three to five pm" as a range of written clock times. */
const formatClockRange = (
  from: number | undefined,
  to: number | undefined,
  meridiem: string | null,
): string | null => {
  if (from === undefined || to === undefined || meridiem === null) return null;
  return `${from} to ${to} ${meridiem}`;
};

/** A clock time opened by a time preposition: "by eleven forty five". */
const formatCuedClockTime = (
  cue: string,
  hour: number | undefined,
  ohMinute: string | undefined,
  minute: string | undefined,
): string | null => {
  const minuteText = ohMinute ?? minute;
  if (hour === undefined || !minuteText) return null;
  const parsedMinute = parseMinuteWords(
    ohMinute ? `o ${ohMinute}` : minuteText,
  );
  if (parsedMinute === null) return null;
  return `${cue} ${hour}:${parsedMinute.toString().padStart(2, "0")}`;
};

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
    (match, from: string, to: string, tail: string) =>
      formatClockRange(
        SMALL_NUMBERS[from.toLowerCase()],
        SMALL_NUMBERS[to.toLowerCase()],
        normalizeMeridiem(tail),
      ) ?? match,
  );

  // "three thirty pm", "three oh five p.m.", "nine am", "twelve o'clock".
  out = out.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+((?:oh|o)?\s?(?:twenty|thirty|forty|fifty)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|(?:oh|o)\s+(?:one|two|three|four|five|six|seven|eight|nine)))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|o'clock)\b/gi,
    (match, hour: string, minute: string | undefined, tail: string) => {
      const parsedHour = SMALL_NUMBERS[hour.toLowerCase()];
      if (parsedHour === undefined) return match;
      return (
        formatClockTime(parsedHour, minute, normalizeMeridiem(tail)) ?? match
      );
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
    ) =>
      formatCuedClockTime(
        cue,
        SMALL_NUMBERS[hour.toLowerCase()],
        ohMinute,
        minute,
      ) ?? match,
  );

  return out;
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
const runText = (
  segments: readonly Segment[],
  from: number,
  to: number,
): string =>
  segments
    .slice(from, to + 1)
    .map((segment) => segment.text)
    .join("");

/**
 * The word that ends the token before this segment, when the two are separate
 * tokens. Used to recognise the "point" a decimal is built on.
 */
const wordBefore = (segments: readonly Segment[], from: number): string => {
  const gap = segments[from - 1];
  const word = segments[from - 2];
  if (!gap?.isSpace || !word || word.isSpace) return "";
  return numberTokenText(word.text).toLowerCase();
};

type NumberRun = {
  words: string[];
  lastTokenIndex: number;
};

/** Whether the words so far contain a scale word ("hundred", "thousand"). */
const hasScaleWord = (words: readonly string[]): boolean =>
  words.some((word) => SCALES[word.toLowerCase()] !== undefined);

/**
 * The words one token adds to a number run, or null when the run ends here.
 *
 * "and" joins a scale word to its remainder and is never a number on its own,
 * so it only continues a run that already had one. A comma groups digits inside
 * one written number ("one thousand, two hundred and thirty four"), so it only
 * carries a run that already had a scale word; anywhere else it separates two
 * numbers, and "we sold twenty, three of them" is twenty and three.
 */
const numberRunStep = (
  candidateText: string,
  words: readonly string[],
  previousToken: string,
): string[] | null => {
  if (isJoiningToken(candidateText)) {
    return hasScaleWord(words) ? ["and"] : null;
  }
  if (!isNumberToken(candidateText)) return null;
  if (previousToken.endsWith(",") && !hasScaleWord(words)) return null;
  return numberWordsOf(candidateText);
};

/**
 * Collects the run of number words that starts here.
 *
 * The run ends at the first word that is not a number, at a word the cardinal
 * parser will reject as a unit ("nineteen eighty four" is one run, so its parts
 * cannot be re-read as smaller ones), and at sentence or clause punctuation,
 * because "one thousand. Twenty five arrived" is two statements and not 1,025.
 */
const collectNumberRun = (
  segments: readonly Segment[],
  start: number,
): NumberRun => {
  const words: string[] = [];
  let lastTokenIndex = start;
  let cursor = start;
  let previousToken = "";

  while (cursor < segments.length) {
    const candidate = segments[cursor];
    if (candidate.isSpace) {
      cursor += 1;
      continue;
    }
    const step = numberRunStep(
      numberTokenText(candidate.text),
      words,
      previousToken,
    );
    if (step === null) break;
    words.push(...step);
    lastTokenIndex = cursor;
    previousToken = candidate.text;
    cursor += 1;
    if (SENTENCE_BOUNDARY_RE.test(candidate.text)) break;
  }

  return { words, lastTokenIndex };
};

type TrailingUnit = {
  currencyPrefix: string;
  percentSuffix: string;
  trailingIndex: number;
  trailingPunctuation: string;
  attributiveUnit: boolean;
};

/** Whether a token is the word "cent" or "cents", punctuation aside. */
const isCentWord = (segment: Segment | undefined): boolean =>
  Boolean(
    segment &&
    !segment.isSpace &&
    ["cent", "cents"].includes(
      segment.text.toLowerCase().replace(/[.,!?;:]+$/, ""),
    ),
  );

/** The word after a run, split into its letters and the punctuation it carries. */
const unitWordAt = (
  segments: readonly Segment[],
  nextIndex: number,
): { lowered: string; punctuation: string } | null => {
  const wordSegment = segments[nextIndex + 1];
  if (!wordSegment || wordSegment.isSpace) return null;
  const lowered = wordSegment.text.toLowerCase().replace(/[.,!?;:]+$/, "");
  return { lowered, punctuation: wordSegment.text.slice(lowered.length) };
};

/**
 * The words that follow a unit word, up to `count`, with their punctuation
 * removed. Empty when the unit ends its sentence: "it costs five pounds. Of
 * course" has no follower, because the full stop belongs to the unit word.
 *
 * `segments` alternates words and whitespace, so the nth word after the unit
 * sits two segments past the previous one.
 */
const unitFollowers = (
  segments: readonly Segment[],
  nextIndex: number,
  count: number,
): string[] => {
  const unit = segments[nextIndex + 1];
  if (!unit || SENTENCE_BOUNDARY_RE.test(unit.text)) return [];
  const words: string[] = [];
  while (words.length < count) {
    const index = nextIndex + 3 + words.length * 2;
    const gap = segments[index - 1];
    const word = segments[index];
    if (!gap?.isSpace || !word || word.isSpace) break;
    words.push(word.text.toLowerCase().replace(/[.,!?;:]+$/, ""));
  }
  return words;
};

/** Whether a singular currency name stands in front of a noun it describes. */
const isAttributiveUnitName = (
  segments: readonly Segment[],
  nextIndex: number,
  lowered: string,
): boolean =>
  SINGULAR_CURRENCY_UNITS.has(lowered) &&
  unitFollowers(segments, nextIndex, 1).length > 0;

/** The two spellings of the unit word this ambiguity belongs to. */
const POUND_WORDS: ReadonlySet<string> = new Set(["pound", "pounds"]);

/** The follower words that make a pound a weight. */
const WEIGHT_FOLLOWERS: ReadonlySet<string> = new Set(["weight", "weights"]);

/** Forms of "weigh", which make the pounds that follow them a weight. */
const WEIGH_WORDS: ReadonlySet<string> = new Set([
  "weigh",
  "weighs",
  "weighed",
  "weighing",
]);

/**
 * Whether a "pound" in this position measures weight rather than money.
 *
 * "Pound" is both. "Five pounds of sugar", "two pound weights", and "it weighs
 * five pounds" are weights; "it costs five pounds" and "a twenty pound note"
 * are money. The phrase after the word and a form of "weigh" before the number
 * are the two cues a dictation gives, and without a cue the word is read as
 * money, which is what it usually is. "Of course" is the one "of" that does not
 * weigh anything.
 */
const isWeightPound = (
  segments: readonly Segment[],
  nextIndex: number,
  runStart: number,
  lowered: string,
): boolean => {
  if (!POUND_WORDS.has(lowered)) return false;
  if (WEIGH_WORDS.has(wordBefore(segments, runStart))) return true;
  const [follower, afterFollower] = unitFollowers(segments, nextIndex, 2);
  if (WEIGHT_FOLLOWERS.has(follower)) return true;
  return follower === "of" && afterFollower !== "course";
};

/**
 * The symbol for a unit word, or undefined when the word is not money.
 *
 * "Pound" is both a currency and a weight, so the money reading is the default
 * and a weight phrase takes it away.
 */
const currencySymbolFor = (
  segments: readonly Segment[],
  nextIndex: number,
  runStart: number,
  lowered: string,
): string | undefined =>
  isWeightPound(segments, nextIndex, runStart, lowered)
    ? undefined
    : CURRENCY_SYMBOLS[lowered];

/** "per cent" and "per cents", where the space and the second word are the unit. */
const readPerCentUnit = (
  segments: readonly Segment[],
  nextIndex: number,
  unit: TrailingUnit,
): TrailingUnit => {
  const cents = segments[nextIndex + 3];
  if (!isCentWord(cents)) return unit;
  const cleaned = cents.text.toLowerCase().replace(/[.,!?;:]+$/, "");
  unit.percentSuffix = "%";
  unit.trailingPunctuation = cents.text.slice(cleaned.length);
  unit.trailingIndex = nextIndex + 3;
  return unit;
};

/**
 * Reads the currency or percent word that follows a run, if there is one.
 *
 * A singular currency name in front of a noun is attributive rather than a
 * unit ("the million dollar question" names a question), so the caller keeps
 * the words it is attached to.
 */
const readTrailingUnit = (
  segments: readonly Segment[],
  nextIndex: number,
  runStart: number,
): TrailingUnit => {
  const unit: TrailingUnit = {
    currencyPrefix: "",
    percentSuffix: "",
    trailingIndex: -1,
    trailingPunctuation: "",
    attributiveUnit: false,
  };
  if (!segments[nextIndex]?.isSpace) return unit;
  const word = unitWordAt(segments, nextIndex);
  if (!word) return unit;

  unit.attributiveUnit = isAttributiveUnitName(
    segments,
    nextIndex,
    word.lowered,
  );
  const currency = currencySymbolFor(
    segments,
    nextIndex,
    runStart,
    word.lowered,
  );
  if (currency) {
    unit.currencyPrefix = currency;
    unit.trailingPunctuation = word.punctuation;
    unit.trailingIndex = nextIndex + 1;
    return unit;
  }
  if (word.lowered === "percent") {
    unit.percentSuffix = "%";
    unit.trailingPunctuation = word.punctuation;
    unit.trailingIndex = nextIndex + 1;
    return unit;
  }
  if (word.lowered !== "per") return unit;
  return readPerCentUnit(segments, nextIndex, unit);
};

/** Whether the run counted anything out, as opposed to only scaling it. */
const hasExplicitQuantity = (words: readonly string[]): boolean =>
  words.some(
    (word) =>
      SMALL_NUMBERS[word.toLowerCase()] !== undefined ||
      TENS[word.toLowerCase()] !== undefined,
  );

/**
 * Whether a run is written out.
 *
 * A currency or percent unit makes it a quantity. Without one, a bare cardinal
 * writes once it is past a single small number. A run after "point" or "dot" is
 * the tail of a decimal this pass does not write, and a scale word on its own
 * in front of an attributive currency name is not a quantity at all, so both
 * keep the words the speaker used.
 */
const isConvertibleRun = (
  parsed: CardinalParse | null,
  words: readonly string[],
  followsDecimalWord: boolean,
  unit: TrailingUnit,
): parsed is CardinalParse => {
  if (parsed === null || followsDecimalWord) return false;
  if (unit.attributiveUnit && !hasExplicitQuantity(words)) return false;
  if (unit.currencyPrefix.length > 0 || unit.percentSuffix.length > 0) {
    return true;
  }
  return isConvertibleBareCardinal(parsed);
};

/** Writes a convertible run, with the punctuation that belonged to it. */
/** The article and the space in front of a run, when they belong to it. */
const dropArticleBeforeNumber = (
  output: string[],
  unit: TrailingUnit,
): void => {
  const previous = output[output.length - 1];
  const beforePrevious = output[output.length - 2];
  if (
    unit.attributiveUnit ||
    beforePrevious === undefined ||
    previous === undefined
  ) {
    return;
  }
  if (!/^(?:a|an)$/i.test(beforePrevious) || !/^\s+$/.test(previous)) return;
  output.pop();
  output.pop();
};

const writeRun = (
  output: string[],
  parsed: CardinalParse,
  unit: TrailingUnit,
  runPunctuation: string,
): void => {
  // "a hundred" and "a twenty" read as quantities once the number is written,
  // so the article that was already emitted goes with it. "a one" never reaches
  // here, and an attributive unit keeps its article ("a $5 bill").
  dropArticleBeforeNumber(output, unit);
  output.push(
    `${unit.currencyPrefix}${formatCardinal(parsed.value)}${unit.percentSuffix}`,
  );
  // The number test stripped the punctuation that ended the sentence on the
  // last word of the run, so it is put back after the digits.
  output.push(
    unit.trailingIndex > 0 ? unit.trailingPunctuation : runPunctuation,
  );
};

/**
 * Converts every run of number words, with the currency or percent word that
 * follows a run folded into the number it belongs to.
 */
const applyCardinalRules = (text: string): string => {
  const segments = segmentText(text);
  const output: string[] = [];
  let index = 0;

  while (index < segments.length) {
    const segment = segments[index];
    if (segment.isSpace || !isNumberToken(numberTokenText(segment.text))) {
      output.push(segment.text);
      index += 1;
      continue;
    }

    const { words, lastTokenIndex } = collectNumberRun(segments, index);
    const nextIndex = lastTokenIndex + 1;
    const parsedRun = parseCardinal(words);
    const unit = readTrailingUnit(segments, nextIndex, index);
    // A run after "point" or "dot" is the tail of a decimal this pass does not
    // write, so it keeps the words the speaker used.
    const followsDecimalWord = ["point", "dot"].includes(
      wordBefore(segments, index),
    );

    if (!isConvertibleRun(parsedRun, words, followsDecimalWord, unit)) {
      output.push(runText(segments, index, lastTokenIndex));
      index = nextIndex;
      continue;
    }

    const runPunctuation =
      segments[lastTokenIndex].text.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
    writeRun(output, parsedRun, unit, runPunctuation);
    index = unit.trailingIndex > 0 ? unit.trailingIndex + 1 : nextIndex;
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
