/**
 * Fast local style transforms — no LLM, no network, <5ms typical.
 *
 * When post-processing mode = "none", the app previously returned raw transcript
 * verbatim for every style except "verbatim". This broke UX for fast providers
 * (Deepgram, AssemblyAI, ElevenLabs, etc.) where user picks "Email" but sees
 * no formatting.
 *
 * Best practices:
 * - Pure, deterministic, no hallucination: never invent content.
 * - Idempotent, fast, provider-agnostic, graceful degradation.
 * - International-safe, length-guarded. "Guarded" means bounded per pass, never
 *   bounded in total: a dictation longer than one chunk is styled across as
 *   many chunks as it takes. Nothing here may shorten text.
 */

import {
  BULLETS_TONE_ID,
  CHAT_TONE_ID,
  CONCISE_TONE_ID,
  EMAIL_TONE_ID,
  FORMAL_TONE_ID,
  NOTES_TONE_ID,
  POLISHED_TONE_ID,
  PROMPT_TONE_ID,
  VERBATIM_TONE_ID,
} from "./tone.utils";

const MAX_INPUT_CHARS = 15000;
const SELF_CORRECTION_MAX_CHARS = 5000;

/**
 * Refuses input larger than one chunk.
 *
 * This used to `slice(0, MAX_INPUT_CHARS)`, which is the whole defect: it
 * returned a styled *prefix* of the dictation and discarded everything after
 * it, so the caller held a string that looked like a complete utterance, could
 * not tell it was short, and delivered half of what the speaker said. The
 * reported character count did not rescue it — by the time it was computed the
 * text had already gone.
 *
 * So nothing in this module may shorten text again. A transform handed an
 * over-long string is a programming error, and `applyFastStyle` already turns a
 * thrown error into the complete raw transcript, which loses nothing.
 */
const assertWithinChunkSize = (text: string): string => {
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(
      `fast style transform received ${text.length} characters, over the ${MAX_INPUT_CHARS} character chunk size; applyFastStyle splits long input before dispatch`,
    );
  }
  return text;
};

/**
 * Sentence terminators: ASCII plus the CJK full stop and the full-width forms.
 * Fast styling is advertised as international-safe, and Japanese or Chinese
 * dictation carries no ASCII punctuation, so a cut that only recognised `.!?`
 * would miss real sentence boundaries there and always fall through to the
 * word-boundary fallback.
 */
/**
 * Every character that ends a sentence. The CJK forms belong here because a
 * dictation can be mixed Latin and CJK.
 *
 * Three places used to spell this set out separately and two of them listed
 * only `.!?`. A sentence ending in `。` was therefore not recognised as a
 * sentence: it stayed one blob, and then `ensureSentencePunctuation` appended a
 * second, ASCII, full stop to text that already had one. The regexes below are
 * built from this list so that cannot happen again.
 */
const TERMINATOR_CHARS = [".", "!", "?", "…", "。", "！", "？"];

const SENTENCE_TERMINATORS: ReadonlySet<string> = new Set(TERMINATOR_CHARS);

const TERMINATOR_CLASS_SOURCE = `[${TERMINATOR_CHARS.map((char) =>
  char.replace(/[\\^\]-]/g, "\\$&"),
).join("")}]`;

/** A sentence boundary is whitespace after a terminator and before a capital. */
const SENTENCE_SPLIT_RE = new RegExp(
  `(?<=${TERMINATOR_CLASS_SOURCE})\\s+(?=[A-Z0-9])`,
  "g",
);

/** Not global, so `.test` carries no `lastIndex` between calls. */
const CONTAINS_TERMINATOR_RE = new RegExp(TERMINATOR_CLASS_SOURCE);
const ENDS_SENTENCE_RE = new RegExp(`${TERMINATOR_CLASS_SOURCE}$`);

/** Matches every Unicode space separator, not just ASCII space. */
const isSpace = (ch: string): boolean => ch.length > 0 && /\s/u.test(ch);

/**
 * Where `text` may be cut inside `[start, end)` without losing or corrupting
 * anything. Three tiers, best first.
 *
 * A sentence boundary wins because it is the only place the transforms treat
 * the start of their input as sentence-initial: `SO_WELL_LEADING_RE` and
 * `PROMPT_OPENER_RE` are anchored to `^`, and `deleteLeadingPhrase` reads
 * `before.length === 0` as "this phrase opened a sentence". A cut anywhere
 * else hands the next chunk a false sentence start, which strips a connective
 * or capitalises a word that was mid-sentence.
 *
 * Whitespace is the fallback, so a cut never lands inside a word. Only a single
 * token longer than the whole chunk size reaches the last tier, and that one
 * steps back a whole code unit when the boundary would fall between a surrogate
 * pair — `slice` counts UTF-16 code units, so cutting at 15000 could otherwise
 * end a chunk on a lone high surrogate.
 */
const findSentenceBoundary = (
  text: string,
  start: number,
  end: number,
): number | null => {
  for (let i = end - 1; i > start; i -= 1) {
    if (!SENTENCE_TERMINATORS.has(text[i])) continue;
    let afterSpace = i + 1;
    while (afterSpace < end && isSpace(text[afterSpace])) afterSpace += 1;
    // A separator inside the window settles it. "3.5" and "www.example.com" are
    // not sentence boundaries because nothing separates them.
    if (afterSpace > i + 1) return afterSpace;
    // The window edge is not a separator. When the terminator is the last
    // character of the chunk, the character after it belongs to the NEXT chunk,
    // so cutting here would hand that chunk a false sentence start -- which
    // strips a connective or capitalises a word that was mid-sentence. The edge
    // still qualifies when what follows is a space, or when there is nothing after
    // it at all; only a non-space character disqualifies it, because then the two
    // halves are the same word.
    if (
      afterSpace >= end &&
      (afterSpace >= text.length || isSpace(text[afterSpace]))
    ) {
      return afterSpace;
    }
  }
  return null;
};

export const findChunkCut = (
  text: string,
  start: number,
  end: number,
): number => {
  const sentence = findSentenceBoundary(text, start, end);
  if (sentence !== null) return sentence;
  for (let i = end - 1; i > start; i -= 1) {
    if (isSpace(text[i])) return i;
  }
  // Only a single token longer than the whole window reaches this tier. Step back
  // when the boundary falls between the two units of an astral character, so the
  // chunk never ends on half of one.
  //
  // Asked from both sides, for the same reason as `capLength` in
  // `packages/utilities/src/error.ts`: `codePointAt` combines a lead with the trail
  // after it, so reading `end - 1` alone returns the finished character and the
  // split becomes invisible. A trail at `end` is that pair's second half, and an
  // unpaired lead at `end - 1` is what `codePointAt` there still reports unchanged.
  const atEnd = end < text.length ? (text.codePointAt(end) as number) : -1;
  const beforeEnd = text.codePointAt(end - 1) as number;
  if (
    (atEnd >= 0xdc00 && atEnd <= 0xdfff) ||
    (beforeEnd >= 0xd800 && beforeEnd <= 0xdbff)
  ) {
    return end - 1;
  }
  return end;
};

/**
 * Splits a dictation into chunks of at most `MAX_INPUT_CHARS`, each ending on a
 * boundary `findChunkCut` approves, so every transform can run over the whole
 * utterance instead of over a prefix of it.
 *
 * Input that already fits comes back as a single chunk unchanged, so a typical
 * dictation takes exactly the path it always did and nothing about its output
 * changes. Nothing is dropped and nothing is re-ordered: the chunks concatenate
 * back to the input.
 */
const splitIntoChunks = (text: string): string[] => {
  if (text.length <= MAX_INPUT_CHARS) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= MAX_INPUT_CHARS) {
      chunks.push(text.slice(start));
      break;
    }
    const windowEnd = start + MAX_INPUT_CHARS;
    const cut = findChunkCut(text, start, windowEnd);
    // `findChunkCut` returns an index above `start` for any window wider than
    // one character, but a cut that fails to advance would spin forever, so the
    // window end is the floor.
    const nextStart = cut > start ? cut : windowEnd;
    chunks.push(text.slice(start, nextStart));
    start = nextStart;
  }

  return chunks.filter((chunk) => chunk.length > 0);
};

/**
 * The one place that decides whether fast styling dropped characters, so a
 * caller reporting the loss to the user can never drift from what was applied.
 *
 * It reports nothing, for any input. It used to count the tail that
 * `truncateGuard` sliced off, which is exactly the loss it was describing: a
 * long dictation was styled up to the cap, the rest was thrown away, and the
 * user learned about it from a warning raised after the text had already been
 * delivered without it. A dictation over the cap is now styled in full over as
 * many chunks as it takes, so there is no dropped text to count.
 *
 * Kept rather than deleted because it is the only channel the pipeline has for
 * "fast styling lost text", and because a non-null result must stay impossible:
 * the cap is a chunk size now, so nothing can fall off the end. Tests pin both
 * halves of that — this returns null, and the tail of an over-cap dictation
 * survives into the styled output.
 */
export const measureFastStyleTruncation = (
  _raw: string,
): { keptChars: number; droppedChars: number } | null => null;

const FILLER_RE = /\b(?:u[hm]+|er+|ah+|h?mm+)\b[,\s]*/gi;

// Conservative: only clear multi-word fillers that cannot be content. "like",
// "basically", "literally", "so", "well" and "actually" must not be deleted
// unconditionally ("I like ice cream", "literally impossible").
// "you know" is a discourse filler only when the speaker commas it off or opens
// with it. "I know you know the answer" is two ordinary verbs, and dropping the
// inner one silently rewrites the statement. "I mean" is the same case: "the
// mean of the data, I mean it statistically" is ordinary English.
// A full stop is not an anchor. "It works. You know it works." uses "you know"
// as the subject of the second sentence, so anchoring there consumed the
// subject and welded the two sentences together. Start-of-text and a preceding
// comma are the only anchors that cannot delete a subject.
// The phrase must also be comma-delimited on the right, or end the transcript.
// "You know it works." and "He said, you know it works." use "you know" as the
// subject of a clause, and "You know what I mean." is a filler whose tail is a
// real clause, so the words after the phrase are what separate the two.
// End-of-text or a full stop keeps the trailing marker: "I know the answer is
// out there, you know" and "I know the answer, you know." are both fillers, and
// nothing follows them to disagree.
// The tail accepts sentence-final punctuation as well as a comma or the end of
// the text, because "I know the answer, you know." ends the sentence there just
// as "..., you know" does. Only punctuation that closes the phrase counts: the
// word after the marker still has to be nothing, a comma, or end of text, so
// "He said, you know it works." keeps its "you know" as the subject.
const EXTRA_FILLER_RE = /(?:^|,\s*)you know\b\s*(?:,\s*|[.!?]+|$)/gi;
const EXTRA_FILLER_COMMA_RE = /(?:^|\s)(?:I mean|so|well)\s*,\s*/gi;
const SO_WELL_LEADING_RE = /^(?:so|well|yeah|okay|ok)\b[,\s]*/i;

const REPEATED_WORD_RE = /\b(\w+)\s+\1\b/gi;

// Self-correction: "X, actually, Y" -> keep Y. Limit to 60 chars of lead-in to
// avoid backtracking. Every marker must be comma-delimited on both sides, so
// ordinary "no" ("I told him no, then we left") and ordinary "I mean" ("the
// mean of the data, I mean it statistically") are left alone.
const SELF_CORRECTION_PRECISE_RE =
  /[^.!?]{1,60},\s*(?:actually,|no,|I mean,|or rather,)\s*/gi;

const CONTRACTION_MAP: Record<string, string> = {
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "can't": "cannot",
  "won't": "will not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "couldn't": "could not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "haven't": "have not",
  "hasn't": "has not",
  "hadn't": "had not",
  "I'm": "I am",
  "you're": "you are",
  "we're": "we are",
  "they're": "they are",
  "it's": "it is",
  "there's": "there is",
  "I've": "I have",
  "you've": "you have",
  "we've": "we have",
  "they've": "they have",
  "I'll": "I will",
  "you'll": "you will",
  "we'll": "we will",
  "they'll": "they will",
  "I'd": "I would",
  "you'd": "you would",
  "we'd": "we would",
  "they'd": "they would",
  "let's": "let us",
  "what's": "what is",
  "who's": "who is",
};

// `contraction.replace("'", "'?")` makes the APOSTROPHE optional, so the pattern
// for `we're` also matched `were`, `it's` matched `its`, and so on. Formal mode
// rewrote ordinary sentences accordingly: "we were ready" came back as "we we are
// ready", "the dog wagged its tail" as "the dog wagged it is tail".
//
// Making the apostrophe optional is right for the other 29 entries, because their bare
// forms are not words and tolerating them is what catches speech-to-text output like
// "dont stop". It is wrong for the seven below, whose bare form IS a word, so for those
// the apostrophe is required. Both directions are deliberate: failing to expand a typo
// costs something that still reads correctly, whereas matching a bare word rewrites a
// sentence the speaker did not say.
//
// The `?` sits between the stem and the final letter, not after the whole word, so
// `can't` compiles to `\bcan'?t\b` and never matched a bare `can`. That is why `can't`
// is absent from this list despite `can` being a word.
// Only membership is ever tested, and the bare form is already written in each
// entry's comment, so this is a set rather than a map whose values nothing reads.
const BARE_STEMS_THAT_ARE_WORDS = new Set([
  "I'll", // "he is ill" became "he is I will"
  "I'd", // "the id number" became "the I would number"
  "it's", // "wagged its tail" became "wagged it is tail"
  "let's", // "he lets go" became "he let us go"
  "we'd", // "they wed in june" became "they we would in june"
  "we'll", // "as well as that" became "as we will as that"
  "we're", // "we were ready" became "we we are ready"
]);

const CONTRACTION_RES: Array<[RegExp, string]> = Object.entries(
  CONTRACTION_MAP,
).map(([contraction, expansion]) => {
  const pattern = BARE_STEMS_THAT_ARE_WORDS.has(contraction)
    ? contraction
    : contraction.replace("'", "'?");
  return [new RegExp(String.raw`\b${pattern}\b`, "gi"), expansion];
});

// Conservative hedging: only clear meta-commentary, not words that change
// meaning like "rather" in "I would rather not go" or "maybe" as content.
const HEDGING_RE =
  /\b(?:I think|I guess|in my opinion|sort of|kind of)\b\s+(\S)/gi;

const REDUNDANT_PHRASES: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bfor the purpose of\b/gi, "for"],
];

const SYMBOL_MAP: Array<[RegExp, string]> = [
  [/\bhashtag\b\s*/gi, "#"],
  [/\bat sign\b\s*/gi, "@"],
  [/\bdot com\b/gi, ".com"],
  [/\bnew line\b/gi, "\n"],
  [/\bnew paragraph\b/gi, "\n\n"],
];

const capitalizeFirst = (s: string): string =>
  s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);

/**
 * Deletes a phrase and repairs the capital that went with it. The pattern must
 * consume the first character of the following word into a capture group.
 *
 * When the phrase opened a sentence, that character is left lowercase by the
 * deletion and has to be put back, otherwise the transform emits "it is fine."
 * mid-paragraph. A phrase removed from the middle of a clause keeps the
 * following word as the speaker said it, so only a sentence-initial removal is
 * repaired.
 */
const deleteLeadingPhrase = (text: string, phrase: RegExp): string =>
  text.replace(
    phrase,
    (_match: string, after: string, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const opensSentence = before.length === 0 || /[.!?]\s+$/.test(before);
      return opensSentence ? capitalizeFirst(after) : after;
    },
  );

/**
 * `isFinal` is false for a chunk that continues into the next one, and the
 * distinction matters because the caller rejoins chunks without consulting a
 * terminator between them. Appending a stop to a chunk that ends mid-sentence invents
 * a sentence break the speaker did not make: a 26,399-character dictation with no
 * terminator came back with a full stop at the seam, and the following chunk was
 * capitalized as though a new sentence began there.
 */
const ensureSentencePunctuation = (
  sentence: string,
  isFinal = true,
): string => {
  const trimmed = sentence.trim();
  if (!trimmed) return "";
  if (ENDS_SENTENCE_RE.test(trimmed)) return trimmed;
  return isFinal ? `${trimmed}.` : trimmed;
};

const splitIntoSentences = (text: string): string[] => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (CONTAINS_TERMINATOR_RE.test(normalized)) {
    return normalized
      .split(SENTENCE_SPLIT_RE)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [normalized];
};

const removeFillerWords = (text: string, aggressive = false): string => {
  let out = text.replace(FILLER_RE, "");
  if (aggressive) {
    out = out.replace(EXTRA_FILLER_RE, " ");
    out = out.replace(EXTRA_FILLER_COMMA_RE, " ");
  }
  out = out.replace(REPEATED_WORD_RE, "$1");
  out = out.replace(/\s{2,}/g, " ").trim();
  out = out.replace(SO_WELL_LEADING_RE, "");
  return out;
};

const fixSelfCorrections = (text: string): string => {
  if (text.length > SELF_CORRECTION_MAX_CHARS) return text;
  let out = text;
  try {
    out = out.replace(SELF_CORRECTION_PRECISE_RE, "");
  } catch {
    return text;
  }
  return out.replace(/\s{2,}/g, " ").trim();
};

const applySymbolReplacements = (text: string): string => {
  let out = text;
  for (const [re, repl] of SYMBOL_MAP) {
    out = out.replace(re, repl);
  }
  return out;
};

const fixCapitalizationAndPunctuation = (
  text: string,
  isFinal = true,
): string => {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return text.trim();
  const isEnglishLike = /[a-zA-Z]/.test(text);
  if (!isEnglishLike) return text.trim();
  return sentences
    .map((s) => capitalizeFirst(ensureSentencePunctuation(s, isFinal)))
    .join(" ");
};

const breakIntoParagraphs = (text: string, sentencesPerPara = 3): string => {
  const sentences = splitIntoSentences(text);
  if (sentences.length <= sentencesPerPara) return sentences.join(" ");
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += sentencesPerPara) {
    paras.push(sentences.slice(i, i + sentencesPerPara).join(" "));
  }
  return paras.join("\n\n");
};

const toPolished = (raw: string, isFinal = true): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  if (!text) return text;
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true);
  text = fixCapitalizationAndPunctuation(text, isFinal);
  text = breakIntoParagraphs(text, 3);
  text = text.replaceAll("—", "-");
  return text;
};

const EMAIL_GREETING_RE = /^(?:hi|hello|hey|dear)\b/i;
const EMAIL_CLOSING_RE =
  /\b(?:thanks|thank you|best|regards|sincerely|cheers)\b/i;

/**
 * An opener or sign-off is only lifted out of the body when it is short. A
 * long opening sentence that merely starts with "Hi" is body, not a greeting.
 */
const isShortEnoughToLift = (
  sentence: string,
  maxWords: number,
  maxChars: number,
): boolean => {
  const trimmed = sentence.trim();
  // Both limits, not either. A four-word opener that runs to several hundred
  // characters is a body sentence, and a two-word line that runs long is a
  // subject line rather than a greeting: `||` let each through on the strength of
  // the limit it happened to satisfy, which is the opposite of a short-greeting
  // limit.
  return trimmed.split(/\s+/).length <= maxWords && trimmed.length <= maxChars;
};

/**
 * A greeting or sign-off is lifted only from the ends of the *dictation*, so
 * the caller passes whether this chunk is at the start and at the end of it.
 *
 * Unscoped, chunking an over-long dictation would lift a mid-dictation "Hi
 * team," on chunk four into a greeting for the whole email, and lift a
 * mid-dictation "Thanks." out of the middle of the body and move it to that
 * chunk's end. Both silently re-order sentences the speaker said in a
 * different order, which is the same class of defect as dropping them.
 */
const splitEmailSections = (
  sentences: string[],
  {
    liftGreeting,
    liftClosing,
  }: { liftGreeting: boolean; liftClosing: boolean },
): { greeting: string; body: string[]; closing: string } => {
  const body = [...sentences];
  let greeting = "";
  let closing = "";

  if (liftGreeting) {
    const first = body.at(0);
    if (
      first &&
      EMAIL_GREETING_RE.test(first) &&
      isShortEnoughToLift(first, 4, 20)
    ) {
      greeting = first;
      body.shift();
    }
  }

  if (liftClosing) {
    const last = body.at(-1);
    if (
      last &&
      EMAIL_CLOSING_RE.test(last) &&
      isShortEnoughToLift(last, 5, 25)
    ) {
      closing = last;
      body.pop();
    }
  }

  return { greeting, body, closing };
};

const joinEmailBlocks = (blocks: string[]): string =>
  blocks
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const toEmail = (
  raw: string,
  {
    liftGreeting,
    liftClosing,
    isFinal,
  }: { liftGreeting: boolean; liftClosing: boolean; isFinal: boolean },
): string => {
  const polished = toPolished(assertWithinChunkSize(raw), isFinal);
  const sentences = splitIntoSentences(polished);
  if (sentences.length === 0) return polished;

  const { greeting, body, closing } = splitEmailSections(sentences, {
    liftGreeting,
    liftClosing,
  });
  const bodyText =
    body.length > 0 ? breakIntoParagraphs(body.join(" "), 2) : "";
  const joined = joinEmailBlocks([greeting, bodyText, closing]);

  return joined || polished;
};

const CHAT_CONNECTIVE_RE =
  /\b(?:furthermore|moreover|additionally|consequently)\b[,\s]+(\S)/gi;

const toChat = (raw: string, isFinal = true): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true);
  const sentences = splitIntoSentences(text);
  const cleaned = sentences
    .map((s) => deleteLeadingPhrase(s, CHAT_CONNECTIVE_RE))
    .map((s) => s.replace(/^[,.\s]+/, "").trim())
    .filter(Boolean);
  let joined = cleaned
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Same seam problem as `ensureSentencePunctuation`, and this one appends the stop
  // directly rather than going through the shared helper. The terminator test is
  // `ENDS_SENTENCE_RE` rather than a bare `[.!?]`, so a dictation already ending in
  // `…`, `。`, `！` or `？` does not pick up a second, ASCII, stop on a CJK sentence.
  if (isFinal && joined && !ENDS_SENTENCE_RE.test(joined)) joined += ".";
  return joined;
};

/** Casual register that has no formal equivalent and is simply dropped. */
const INFORMAL_RE = /\b(?:gonna|wanna|gotta|kinda|sorta|yeah|yep|nope)\b/gi;

const expandContractions = (text: string): string => {
  let out = text;
  for (const [re, expansion] of CONTRACTION_RES) {
    out = out.replace(re, (match: string) => {
      const isCapitalized = match.startsWith(match[0].toUpperCase());
      return isCapitalized ? capitalizeFirst(expansion) : expansion;
    });
  }
  return out;
};

const toFormal = (raw: string, isFinal = true): string => {
  const text = expandContractions(
    toPolished(assertWithinChunkSize(raw), isFinal),
  )
    .replace(INFORMAL_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return fixCapitalizationAndPunctuation(text, isFinal);
};

/** Politeness openers that add nothing once the ask has been extracted. */
const PROMPT_OPENER_RE = /^(?:hey|hi|hello|so|well|um|uh)\b[,\s]*/i;
const PROMPT_REQUEST_RE =
  /^(?:can you|could you|would you|please|I need you to|I want you to|I need|I want)\b\s*/i;

const toPrompt = (raw: string, isFinal = true): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true);
  text = text.replace(PROMPT_OPENER_RE, "").replace(PROMPT_REQUEST_RE, "");

  // Every sentence is kept. Condensing the request must not drop a constraint
  // the speaker stated after the opening, such as a deadline or a format
  // requirement, so this strips the politeness framing and nothing else.
  const out = text.trim() || guarded.trim();
  if (!out) return out;
  const cased = capitalizeFirst(out);
  // This appends directly rather than going through `ensureSentencePunctuation`, so
  // it needs `isFinal` as well, and it needs the same CJK-aware terminator test: a
  // bare `[.!?]` left "第一句。" coming back as "第一句。.".
  return isFinal && !ENDS_SENTENCE_RE.test(cased) ? `${cased}.` : cased;
};

const EDGE_PUNCTUATION_RE = /[,.;\s]/;

/**
 * Scans inward from both ends and drops the punctuation and whitespace there. A
 * pair of anchored character-class replaces does the same job but backtracks,
 * which Sonar flags on this path.
 *
 * The single character class is the source of truth. An earlier version kept a
 * Set of ASCII literals next to it, which quietly dropped every Unicode
 * whitespace character from the class, including no-break space, thin space and
 * ideographic space. Deriving the predicate from the class removes the way the
 * two could drift apart again.
 */
export const stripEdgePunctuation = (text: string): string => {
  if (!EDGE_PUNCTUATION_RE.test(text)) return text;
  let start = 0;
  let end = text.length;
  while (start < end && EDGE_PUNCTUATION_RE.test(text[start])) start += 1;
  while (end > start && EDGE_PUNCTUATION_RE.test(text[end - 1])) end -= 1;
  return text.slice(start, end);
};

const toBullets = (raw: string): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true);

  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return text;

  const ideas: string[] = [];
  for (const s of sentences) {
    const parts = s.includes(";") ? s.split(";") : [s];
    for (const p of parts) {
      const trimmed = stripEdgePunctuation(p);
      // An idea is anything with a letter or a digit in it. A length threshold
      // cannot decide this: at 2 characters it drops "no", and because the
      // fallback below only applies when EVERY fragment was short, one longer
      // sibling was enough to delete the short ones -- so "Go; no; stop." became a
      // single bullet reading "Stop". `stripEdgePunctuation` only removes
      // `[,.;\s]`, so a length test cannot see the difference between an em dash
      // and a real idea either.
      if (/[\p{L}\p{N}]/u.test(trimmed)) ideas.push(trimmed);
    }
  }

  const source = ideas.length > 0 ? ideas : sentences;

  const bullets = source.map((idea) => {
    let out = idea.trim().replace(/^[•\-*]\s*/u, "");
    out = capitalizeFirst(out.replace(/\.$/, "").trim());
    return `- ${out}`;
  });

  return bullets.join("\n");
};

const toConcise = (raw: string, isFinal = true): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true);
  text = deleteLeadingPhrase(text, HEDGING_RE);
  for (const [re, repl] of REDUNDANT_PHRASES) {
    text = text.replace(re, repl);
  }
  text = text.replace(/\s{2,}/g, " ").trim();
  return fixCapitalizationAndPunctuation(text, isFinal);
};

const toNotes = (raw: string): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true);
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return text;

  const actionRe =
    /\b(?:need to|should|must|will|todo|action|next step|follow up|decide|decision)\b/i;
  const notes: string[] = [];
  const actions: string[] = [];

  for (const s of sentences) {
    if (actionRe.test(s)) actions.push(s);
    else notes.push(s);
  }

  const parts: string[] = [];
  if (notes.length > 0) {
    parts.push(
      notes.map((s) => `- ${capitalizeFirst(s.replace(/\.$/, ""))}`).join("\n"),
    );
  }
  if (actions.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push(
      actions
        .map((s) => `- [ ] ${capitalizeFirst(s.replace(/\.$/, ""))}`)
        .join("\n"),
    );
  }

  return parts.join("\n").trim() || toBullets(guarded);
};

/**
 * How the styled chunks of one tone are rejoined. A tone whose output is
 * line-structured rejoins on the same separator it uses internally, so the join
 * is invisible; the sentence-shaped tones rejoin on a space, which is what they
 * use between sentences already.
 */
const CHUNK_JOIN_BY_TONE: Readonly<Record<string, string | undefined>> = {
  [EMAIL_TONE_ID]: "\n\n",
  [BULLETS_TONE_ID]: "\n",
  [NOTES_TONE_ID]: "\n",
};

const applyStyleToChunk = (
  chunk: string,
  toneId: string,
  position: { isFirst: boolean; isLast: boolean },
): string => {
  switch (toneId) {
    case POLISHED_TONE_ID:
    case "default":
      return toPolished(chunk, position.isLast);
    case EMAIL_TONE_ID:
      return toEmail(chunk, {
        liftGreeting: position.isFirst,
        liftClosing: position.isLast,
        isFinal: position.isLast,
      });
    case CHAT_TONE_ID:
      return toChat(chunk, position.isLast);
    case FORMAL_TONE_ID:
      return toFormal(chunk, position.isLast);
    case PROMPT_TONE_ID:
      return toPrompt(chunk, position.isLast);
    case BULLETS_TONE_ID:
      return toBullets(chunk);
    case CONCISE_TONE_ID:
      return toConcise(chunk, position.isLast);
    case NOTES_TONE_ID:
      return toNotes(chunk);
    default:
      // Custom and deprecated tones reach here only when a caller skipped
      // canApplyFastStyle. A free-form prompt cannot be honoured locally, and a
      // deprecated tone has no transform that matches what it promised, so return
      // the input unchanged rather than silently picking a different style.
      return chunk;
  }
};

/**
 * Applies the tone to the whole dictation.
 *
 * A dictation longer than `MAX_INPUT_CHARS` is styled over as many chunks as it
 * takes and the results concatenated, so the returned text always covers the
 * entire input. It used to be `slice`d to the cap and the tail discarded, which
 * made this return a styled prefix indistinguishable from a complete utterance.
 * The cap is now a chunk size rather than a truncation point.
 *
 * `toEmail` is the only transform that carries state across its input — it lifts
 * a greeting off the front and a sign-off off the back — so it needs to know where
 * its chunk sits for that reason. Every transform is told now: the terminator a
 * chunk appends has to be suppressed on a chunk that continues into the next one,
 * whichever tone produced it.
 */
export const applyFastStyle = (
  rawTranscript: string,
  toneId: string | null,
): string => {
  const trimmed = rawTranscript.trim();
  if (!trimmed) return trimmed;

  if (!toneId || toneId === VERBATIM_TONE_ID || toneId === "disabled") {
    return rawTranscript;
  }

  try {
    const chunks = splitIntoChunks(trimmed);
    const lastIndex = chunks.length - 1;
    return chunks
      .map((chunk, index) =>
        applyStyleToChunk(chunk, toneId, {
          isFirst: index === 0,
          isLast: index === lastIndex,
        }),
      )
      .join(CHUNK_JOIN_BY_TONE[toneId] ?? " ");
  } catch {
    // A transform threw. The raw transcript is the only answer that cannot lose
    // what was said, so it is what the caller gets.
    return rawTranscript;
  }
};

/**
 * The tones `applyFastStyle` has a real transform for. A custom tone carries a
 * free-form prompt, so applying some other tone's transform would hand the user
 * a style they did not pick, and the more aggressive transforms can drop words.
 * `canApplyFastStyle` gates on this set so a custom tone takes the raw path
 * instead.
 *
 * The deprecated `light`, `casual`, `business` and `punny` used to be listed
 * here and dispatched to `toPolished`. That is the same substitution this set
 * exists to prevent: the user picked a style, got Polished, and lost whatever
 * `toPolished` strips as filler. `punny` cannot be honoured locally at all --
 * its prompt asks for jokes, and `toPolished` produces plain prose. They are
 * not listed now, so they take the raw path. A tone persisted by an older build
 * stays selectable and reaches the provider with its real prompt, which is
 * closer to what the user asked for than a local transform that discards words.
 * `formal` needs no entry beyond `FORMAL_TONE_ID`, which is the same string.
 */
const FAST_STYLE_TONE_IDS: ReadonlySet<string> = new Set([
  POLISHED_TONE_ID,
  EMAIL_TONE_ID,
  CHAT_TONE_ID,
  FORMAL_TONE_ID,
  PROMPT_TONE_ID,
  BULLETS_TONE_ID,
  CONCISE_TONE_ID,
  NOTES_TONE_ID,
]);

/**
 * Whether a local transform exists for this tone. Provider-agnostic by design:
 * the transforms are pure string operations, so every provider gets the same
 * result for the same input.
 */
export const canApplyFastStyle = (toneId: string | null): boolean => {
  if (!toneId) return false;
  return FAST_STYLE_TONE_IDS.has(toneId);
};

/**
 * The size of one styling chunk. Input at or under this is styled in a single
 * pass exactly as it always was; longer input is split at sentence or word
 * boundaries and every chunk is styled, so nothing past this number is dropped.
 */
export const FAST_STYLE_MAX_INPUT_CHARS = MAX_INPUT_CHARS;
