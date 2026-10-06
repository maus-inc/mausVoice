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
  isSpokenNumberWord,
  normalizeSpokenForms,
} from "./inverse-text-normalization.utils";
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
  char.replace(/[\\^\]-]/g, String.raw`\$&`),
).join("")}]`;

/** A sentence boundary is whitespace after a terminator and before a capital. */
const SENTENCE_SPLIT_RE = new RegExp(
  String.raw`(?<=${TERMINATOR_CLASS_SOURCE})\s+(?=[A-Z0-9])`,
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
 * One chunk of a long dictation, plus what the transforms need to know about where it
 * starts.
 */
type Chunk = { text: string; startsSentence: boolean };

/**
 * Splits a dictation into chunks of at most `MAX_INPUT_CHARS`, each ending on a
 * boundary `findChunkCut` approves, so every transform can run over the whole
 * utterance instead of over a prefix of it.
 *
 * Input that already fits comes back as a single chunk unchanged, so a typical
 * dictation takes exactly the path it always did and nothing about its output
 * changes. Nothing is dropped and nothing is re-ordered: the chunks concatenate
 * back to the input.
 *
 * `startsSentence` is the part that is not just bookkeeping. A chunk cut on a sentence
 * boundary opens a sentence, and one cut at whitespace opens the middle of one -- and
 * the transforms cannot tell the two apart on their own, because each of them TRIMS its
 * chunk before running the `^`-anchored opener removals. Measured on a dictation with
 * no terminator in the window: `so I went home` at the seam came back as `I went home`
 * under four tones, because the whitespace fallback returns the index OF a space and the
 * trim removed the one character that had marked the chunk as mid-sentence.
 */
const splitIntoChunks = (text: string): Chunk[] => {
  if (text.length <= MAX_INPUT_CHARS) return [{ text, startsSentence: true }];

  const chunks: Chunk[] = [];
  let start = 0;
  // Only the first chunk is known to open a sentence; a later one opens one only if the
  // cut that produced it was a sentence boundary.
  let startsSentence = true;
  while (start < text.length) {
    if (text.length - start <= MAX_INPUT_CHARS) {
      chunks.push({ text: text.slice(start), startsSentence });
      break;
    }
    const windowEnd = start + MAX_INPUT_CHARS;
    const cut = findChunkCut(text, start, windowEnd);
    // `findChunkCut` returns an index above `start` for any window wider than
    // one character, but a cut that fails to advance would spin forever, so the
    // window end is the floor.
    const nextStart = cut > start ? cut : windowEnd;
    chunks.push({ text: text.slice(start, nextStart), startsSentence });
    // A cut at a real sentence boundary is the one case where the next chunk opens a
    // sentence, and `findChunkCut` does not say which tier produced the cut -- so the
    // text has to. Two characters decide it, because `findSentenceBoundary` has TWO
    // returns and they point at different things:
    //
    //   `afterSpace > i + 1`  returns PAST the whitespace run, so the character at the
    //                         cut is the next chunk's first letter;
    //   `afterSpace >= end`   returns `afterSpace`, which equals `end`, so it points AT
    //                         the separator -- the terminator was the last character of
    //                         the window. That is still a real boundary, and the test
    //                         "still takes a real boundary that falls on the window edge"
    //                         pins that it is.
    //
    // So a non-space at the cut means a sentence start, and a space at the cut means one
    // ONLY if the character before it terminates a sentence. Reading it the other way --
    // a space always meaning mid-sentence -- left an opener behind the second return
    // unremoved: the same words came back as "Alpha. so I went home." under the cap and
    // "alpha alpha alpha. So I went home." over it.
    //
    // The terminator set is the one `findSentenceBoundary` itself tests, so the two agree
    // on what counts; the whitespace vocabulary needs no separate case, because both
    // functions use the same `isSpace`.
    startsSentence =
      nextStart < text.length &&
      (!isSpace(text[nextStart] ?? "") ||
        (nextStart > start &&
          SENTENCE_TERMINATORS.has(text[nextStart - 1] ?? "")));
    start = nextStart;
  }

  return chunks.filter((chunk) => chunk.text.length > 0);
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
//
// The two anchors cannot share a tail. Mid-text one requires a preceding comma,
// so a full stop after the marker proves the marker was mid-clause. At `^` there
// is no preceding comma to require, and accepting `[.!?]+` there deleted a whole
// opening sentence: "You know. It works." styled to "It works.", which is the
// silent data loss this module ranks above a mispunctuated sentence. A full stop
// immediately after a LEADING marker means the marker was its own sentence and
// the words after it began a new one, so `^` accepts only a comma or the end of
// the text -- the two shapes that really do make it a discourse marker.
// The two anchors are two patterns, which is what the argument above asks for. One
// alternation carrying both had a single tail that could not be right for either anchor, and
// splitting them is also what brought the pair under the complexity budget the analyzer
// reports against a single regex here.
//
// Equivalent output, but only in one order -- see the call site. The equivalence was first
// measured over 180 probes that placed ONE marker at a time, which passed in either order
// and was not enough: two markers in one string is the axis that decides it, and it is
// pinned by a test.
const EXTRA_FILLER_LEADING_RE = /^you know\b\s*(?:,\s*|$)/gi;
const EXTRA_FILLER_MID_RE = /,\s*you know\b\s*(?:,\s*|[.!?]+|$)/gi;
// One list, two patterns. `EXTRA_FILLER_COMMA_LEADING_RE` matches a comma-filled
// connective that OPENED the text, and `EXTRA_FILLER_COMMA_MID_RE` one that sat inside a
// clause; together they are the whole of what the single pattern used to do, and they are
// kept apart because only the first is wrong on a chunk that merely continues a sentence.
// The marker list is written once so the two cannot drift apart.
const EXTRA_FILLER_COMMA_MARKERS = "I mean|so|well";
const EXTRA_FILLER_COMMA_LEADING_RE = new RegExp(
  String.raw`^(?:${EXTRA_FILLER_COMMA_MARKERS})\s*,\s*`,
  "gi",
);
const EXTRA_FILLER_COMMA_MID_RE = new RegExp(
  String.raw`\s(?:${EXTRA_FILLER_COMMA_MARKERS})\s*,\s*`,
  "gi",
);
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
  "I've": "I have",
  "you've": "you have",
  "we've": "we have",
  "they've": "they have",
  "I'll": "I will",
  "you'll": "you will",
  "we'll": "we will",
  "they'll": "they will",
  "let's": "let us",
};

// `contraction.replace("'", "'?")` makes the APOSTROPHE optional, so the pattern
// for `we're` also matched `were`, `it's` matched `its`, and so on. Formal mode
// rewrote ordinary sentences accordingly: "we were ready" came back as "we we are
// ready", "the dog wagged its tail" as "the dog wagged it is tail".
//
// Making the apostrophe optional is right for most entries, because their bare forms
// are not words and tolerating them is what catches speech-to-text output like
// "dont stop". It is wrong for the entries below, whose bare form IS a word, so for those
// the apostrophe is required. Both directions are deliberate: failing to expand a typo
// costs something that still reads correctly, whereas matching a bare word rewrites a
// sentence the speaker did not say.
//
// This set arbitrates one thing only: whether the apostrophe must be there. It cannot
// pick between two readings of an apostrophised form, so the entries whose two
// readings differ are not in the map at all rather than being resolved here. Those are
// the four `'d` entries and the four ambiguous `'s` ones -- `it's`, `there's`, `what's`,
// `who's` -- because `'d` is *would* or *had* and those `'s` are *is* or *has*.
//
// Naming them as "the `'d` family and the `'s` family" was wrong and read as though no
// `'s` form survived, which a grep contradicts: `let's` is still in the map at :289,
// because it has exactly one reading. It is the bare `lets` that collides, and that is
// what its entry in this set below is for.
//
// The `?` sits between the stem and the final letter, not after the whole word, so
// `can't` compiles to `\bcan'?t\b` and never matched a bare `can`. That is why `can't`
// is absent from this list despite `can` being a word.
// Only membership is ever tested, and the bare form is already written in each
// entry's comment, so this is a set rather than a map whose values nothing reads.
const BARE_STEMS_THAT_ARE_WORDS = new Set([
  "I'll", // "he is ill" became "he is I will"
  "let's", // "he lets go" became "he let us go"
  "we'll", // "as well as that" became "as we will as that"
  "we're", // "we were ready" became "we we are ready"
  "won't", // "he was wont to nod" became "he was will not to nod"
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

const SPOKEN_TLD_SOURCE = "com|org|net|io|ai|co|dev|app";

const SYMBOL_MAP: Array<[RegExp, string]> = [
  [/\bhashtag\b\s*/gi, "#"],
  [/\bat sign\b\s*/gi, "@"],
  [/\bnew line\b/gi, "\n"],
  [/\bnew paragraph\b/gi, "\n\n"],
];

// Grammar rather than content. In front of "dot" these words make a phrase
// ("the dot com bubble"), not a domain, and as the local part of a spoken
// address they are what "at" already said ("look at example.com"), so both
// address rules refuse them.
const SPOKEN_ADDRESS_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "our",
  "their",
  "its",
  "his",
  "her",
  "him",
  "them",
  "me",
  "it",
  "us",
  "you",
  "i",
  "we",
  "they",
  "he",
  "she",
  "there",
  "here",
  "now",
  "then",
  "look",
  "back",
  "no",
  "not",
  "each",
  "every",
  "one",
  "all",
  "some",
  "any",
]);

// A spoken domain is "<host> dot <tld>". The host is what keeps the space in
// "example dot com" from becoming "example .com", and it has to be introduced
// the way an address is: "to", "at", "is", a preposition, or one of the words
// that name a site. Without that, the host is whatever noun sat in front of
// "dot" -- the earlier rule that joined the pair on its own wrote
// "The.com bubble" and "in the.com folder", and matching any two words wrote
// "we use.com". "dot" is as common as "at", so the frame is the evidence that
// separates an address from a phrase, exactly as it does for the email rule. A
// dictation that is only a domain ("example dot com" on its own) therefore keeps
// its words, which is the price of never inventing one.
const SPOKEN_DOMAIN_FRAME_SOURCE = "to|is|at|on|from|via|visit|called|named";
const SPOKEN_DOMAIN_FRAMES: ReadonlySet<string> = new Set(
  SPOKEN_DOMAIN_FRAME_SOURCE.split("|"),
);
const SPOKEN_DOMAIN_RE = new RegExp(
  String.raw`\b([\p{L}\p{N}][\p{L}\p{N}-]*)\s+dot\s?(${SPOKEN_TLD_SOURCE})\b`,
  "giu",
);

// A spoken email address: "<local part> at <domain>.<tld>". "at" is one of the
// commonest words in English, so the local part must be introduced by a frame
// that promises an address ("to", "is", "contact"...) and must not itself be a
// function word, otherwise "look at example.com" would lose its verb.
const SPOKEN_EMAIL_FRAME_SOURCE = "to|is|contact|reach";
const SPOKEN_EMAIL_RE = new RegExp(
  String.raw`\b(?:${SPOKEN_EMAIL_FRAME_SOURCE})\s+([\p{L}\p{N}._%+-]{2,})\s+at\s+([\p{L}\p{N}-]+\.(?:${SPOKEN_TLD_SOURCE}))\b`,
  "giu",
);

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

/**
 * Sentence count under the same definition the transforms split on: a text
 * with no sentence terminator is one sentence, not zero. Callers that decide
 * whether input is short enough for the local path use this rather than a
 * second, drifting definition of a sentence.
 */
export const countFastStyleSentences = (text: string): number =>
  splitIntoSentences(text).length;

const removeFillerWords = (
  text: string,
  aggressive = false,
  startsSentence = true,
): string => {
  let out = text.replace(FILLER_RE, "");
  if (aggressive) {
    // LEADING first, then MID, and the order is load-bearing. The mid pattern is not
    // anchored, so running it first can consume a `, you know<tail>` that sits inside the
    // span the leading anchor owns, and the leading pass then fires again on the text the
    // mid pass rewrote -- removing two markers where the single alternation removed one,
    // and swallowing the sentence's closing punctuation on the way. `you know, you know?`
    // came back as one space instead of ` you know?`, and `you know, you know? Did you?`
    // came back as `you know  Did you?` -- the punctuation and the second marker's tail
    // gone. Through the module both of those style to an EMPTY string, which is the
    // outcome this module's own comments rank above a mispunctuated sentence.
    //
    // Leading first cannot do that. It matches at index 0 at most once -- `^` without the
    // `m` flag cannot re-match past `lastIndex` -- so it consumes some span [0, k) and
    // leaves the rest of the string alone. The mid pass then scans from new-index 1, which
    // is original-index k: exactly where the single alternation resumes, because it too
    // resumes past its first match. And the leading pass cannot create a mid match of its
    // own, because it replaced its span with a single space where mid requires a comma.
    out = out
      .replace(EXTRA_FILLER_LEADING_RE, " ")
      .replace(EXTRA_FILLER_MID_RE, " ");
    // `EXTRA_FILLER_COMMA_RE` is `(?:^|\s)(?:I mean|so|well)\s*,\s*`, so it has an
    // anchored alternative as well as a mid-clause one, and both DELETE. Only the anchored
    // alternative is what a false sentence start feeds, so only that one is gated: the
    // `^` branch is replaced out of the pattern rather than skipped, because skipping the
    // whole replace would also stop the `\s` branch from firing mid-clause, which is
    // separate existing behaviour this does not change.
    //
    // So a chunk that continues a sentence keeps `so,` and `I mean,`; a chunk that opens
    // one still loses them, and a mid-clause one still loses them as it always did.
    out = out.replace(EXTRA_FILLER_COMMA_MID_RE, " ");
    if (startsSentence) out = out.replace(EXTRA_FILLER_COMMA_LEADING_RE, " ");
  }
  // A repeated number word is a number, not a stutter: "twenty twenty six" is a
  // year and "nine nine nine" is what it looks like, and the written-form pass
  // reads the repetition to tell both apart from a count.
  out = out.replace(REPEATED_WORD_RE, (match, word: string) =>
    isSpokenNumberWord(word) ? match : word,
  );
  out = out.replace(/\s{2,}/g, " ").trim();
  // Only on a chunk that really does open a sentence. `SO_WELL_LEADING_RE` is anchored
  // to `^` and it DELETES, so on a chunk cut at whitespace it would take a connective the
  // speaker used mid-sentence. `startsSentence` is what distinguishes the two, and it
  // cannot be recovered from the text: every transform trims its chunk first, which is
  // what removed the leading space that had marked the seam.
  if (startsSentence) out = out.replace(SO_WELL_LEADING_RE, "");
  return out;
};

// Self-correction markers that do not need the comma the precise pattern
// requires. "make that" and "wait no" are part of the shape of the sentence, and
// so is the corrected value itself: only the single token before the marker is
// dropped, which is what keeps "send the report by friday no wait thursday" as
// "send the report by thursday" instead of losing the request with the date.
const SELF_CORRECTION_MARKER_SOURCE =
  "no wait make that|no wait|wait no|make that|or rather|sorry i meant|i meant";

const SELF_CORRECTION_UNPUNCTUATED_RE = new RegExp(
  String.raw`(\S+)(\s+(?:${SELF_CORRECTION_MARKER_SOURCE})\s*,?\s+)(\S+)`,
  "gi",
);

// The last word of every marker phrase. The pattern matches a marker from the
// token in front of it, so a marker at the start of the text can hand its own
// word in as the lead: "no wait make that thursday" put "wait" in front of
// "make that" and the token before it was deleted, turning the dictation into
// "No Thursday." A lead that is itself part of a marker is not a value being
// corrected.
const SELF_CORRECTION_MARKER_TAILS: ReadonlySet<string> = new Set(
  SELF_CORRECTION_MARKER_SOURCE.split("|").map(
    (marker) => marker.split(" ").pop() ?? "",
  ),
);

// A token that makes the phrase in front of the marker an ordinary English
// phrase rather than a value being corrected: "there is no wait at the clinic".
const SELF_CORRECTION_LEAD_STOPLIST = new Set([
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "there",
  "the",
  "a",
  "an",
  "and",
  "but",
  "or",
  "with",
  "without",
  "of",
  "for",
  "in",
  "on",
  "at",
  "no",
  "not",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "must",
  "may",
  "might",
  "to",
  "from",
  "so",
  "then",
  "if",
  "when",
  "while",
  "after",
  "before",
]);

const fixSelfCorrections = (text: string): string => {
  if (text.length > SELF_CORRECTION_MAX_CHARS) return text;
  let out = text;
  try {
    out = out.replace(
      SELF_CORRECTION_UNPUNCTUATED_RE,
      (
        _match,
        lead: string,
        _marker: string,
        after: string,
        offset: number,
        whole: string,
      ) => {
        const cleanedLead = lead.toLowerCase().replace(/[^a-z']/g, "");
        if (!cleanedLead || SELF_CORRECTION_LEAD_STOPLIST.has(cleanedLead)) {
          return _match;
        }
        if (SELF_CORRECTION_MARKER_TAILS.has(cleanedLead)) return _match;
        // "sorry i meant to call you" is an apology, not a correction of the
        // word in front of the marker, so an infinitive after it is left alone.
        if (after.toLowerCase().replace(/[^a-z']/g, "") === "to") {
          return _match;
        }
        // The deleted span may have opened a sentence, in which case the word
        // that follows it needs the capital back.
        const before = whole.slice(0, offset);
        const opensSentence = before.length === 0 || /[.!?]\s+$/.test(before);
        return opensSentence ? capitalizeFirst(after) : after;
      },
    );
    out = out.replace(SELF_CORRECTION_PRECISE_RE, "");
  } catch {
    return text;
  }
  return out.replace(/\s{2,}/g, " ").trim();
};

const joinSpokenDomains = (text: string): string =>
  text.replace(
    SPOKEN_DOMAIN_RE,
    (
      match,
      host: string,
      tld: string,
      offset: number,
      whole: string,
    ): string => {
      if (SPOKEN_ADDRESS_STOPWORDS.has(host.toLowerCase())) return match;
      const before = whole.slice(0, offset).match(/(\S+)\s+$/);
      const frame = before?.[1].toLowerCase().replace(/[^a-z]/g, "") ?? "";
      return SPOKEN_DOMAIN_FRAMES.has(frame) ? `${host}.${tld}` : match;
    },
  );

const joinSpokenEmails = (text: string): string =>
  text.replace(SPOKEN_EMAIL_RE, (match, localPart: string, domain: string) => {
    const frame = match.slice(0, match.toLowerCase().indexOf(" at "));
    if (SPOKEN_ADDRESS_STOPWORDS.has(localPart.toLowerCase())) return match;
    return `${frame} ${localPart}@${domain}`;
  });

const applySymbolReplacements = (text: string): string => {
  let out = text;
  for (const [re, repl] of SYMBOL_MAP) {
    out = out.replace(re, repl);
  }
  return joinSpokenEmails(joinSpokenDomains(out));
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

const toPolished = (
  raw: string,
  isFinal = true,
  startsSentence = true,
): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  if (!text) return text;
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true, startsSentence);
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
    startsSentence,
  }: {
    liftGreeting: boolean;
    liftClosing: boolean;
    isFinal: boolean;
    startsSentence: boolean;
  },
): string => {
  const polished = toPolished(
    assertWithinChunkSize(raw),
    isFinal,
    startsSentence,
  );
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

const toChat = (raw: string, isFinal = true, startsSentence = true): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true, startsSentence);
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

/**
 * Casual register, rewritten rather than dropped. Deleting was the first version
 * and it was wrong three ways over. `nope` has a formal equivalent -- `no` -- so
 * deleting it inverts a negation rather than changing register. And the elided-`to`
 * forms (`gonna`, `wanna`, `gotta`) left a verb with nothing to attach to, because
 * `expandContractions` has already rewritten "I'm" as "I am" by the time this
 * runs: "I'm gonna go now" became "I am go now." A deletion also leaves punctuation
 * behind, and `fixCapitalizationAndPunctuation` capitalizes the first character of
 * each sentence, which `capitalizeFirst` leaves alone when it is a comma -- so a
 * comma that moved to the front survives as its own defect, at any sentence start
 * rather than only at index 0.
 */
const INFORMAL_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgonna\b/gi, "going to"],
  [/\bwanna\b/gi, "want to"],
  [/\bgotta\b/gi, "got to"],
  [/\bkinda\b/gi, "somewhat"],
  [/\bsorta\b/gi, "somewhat"],
  [/\byeah\b/gi, "yes"],
  [/\byep\b/gi, "yes"],
  [/\bnope\b/gi, "no"],
];

const rewriteInformalRegister = (text: string): string => {
  let out = text;
  for (const [pattern, replacement] of INFORMAL_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  return out;
};

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

const toFormal = (
  raw: string,
  isFinal = true,
  startsSentence = true,
): string => {
  const text = rewriteInformalRegister(
    expandContractions(
      toPolished(assertWithinChunkSize(raw), isFinal, startsSentence),
    ),
  )
    .replace(/\s{2,}/g, " ")
    .trim();
  return fixCapitalizationAndPunctuation(text, isFinal);
};

/** Politeness openers that add nothing once the ask has been extracted. */
const PROMPT_OPENER_RE = /^(?:hey|hi|hello|so|well|um|uh)\b[,\s]*/i;
const PROMPT_REQUEST_RE =
  /^(?:can you|could you|would you|please|I need you to|I want you to|I need|I want)\b\s*/i;

const toPrompt = (
  raw: string,
  isFinal = true,
  startsSentence = true,
): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true, startsSentence);
  // Both are anchored to `^` and both DELETE, and `PROMPT_REQUEST_RE` is the one that
  // takes request words: `Can you send that file over again` at a whitespace seam came
  // back as `Send it again`. Gated for the same reason as `SO_WELL_LEADING_RE` above.
  if (startsSentence) {
    text = text.replace(PROMPT_OPENER_RE, "").replace(PROMPT_REQUEST_RE, "");
  }

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

const toBullets = (raw: string, startsSentence = true): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true, startsSentence);

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
      // single bullet reading "Stop". The threshold that was here did drop a lone em
      // dash and a bare hyphen, but only as a side effect of counting characters; the
      // test names the property instead.
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

const toConcise = (
  raw: string,
  isFinal = true,
  startsSentence = true,
): string => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true, startsSentence);
  text = deleteLeadingPhrase(text, HEDGING_RE);
  for (const [re, repl] of REDUNDANT_PHRASES) {
    text = text.replace(re, repl);
  }
  text = text.replace(/\s{2,}/g, " ").trim();
  return fixCapitalizationAndPunctuation(text, isFinal);
};

const ACTION_SENTENCE_RE =
  /\b(?:need to|should|must|will|todo|action|next step|follow up|decide|decision)\b/i;

/** What one chunk's sentences are: the ordinary ones, and the ones that name an action. */
type NoteBuckets = { notes: string[]; actions: string[] };

/**
 * Split ONE chunk's sentences into the two buckets, without emitting either.
 *
 * Split out of the emit step because the two have to happen at different scopes. This
 * function does no emitting at all: classification is per chunk because the chunk cap is per
 * chunk, and the RESULT is accumulated across all of them before anything is written -- see
 * `applyFastStyle`.
 */
const classifyForNotes = (raw: string, startsSentence = true): NoteBuckets => {
  const guarded = assertWithinChunkSize(raw);
  let text = guarded.trim();
  text = applySymbolReplacements(text);
  text = fixSelfCorrections(text);
  text = removeFillerWords(text, true, startsSentence);
  const notes: string[] = [];
  const actions: string[] = [];
  for (const sentence of splitIntoSentences(text)) {
    if (ACTION_SENTENCE_RE.test(sentence)) actions.push(sentence);
    else notes.push(sentence);
  }
  return { notes, actions };
};

/** Fold one chunk's buckets into the running totals, preserving order. */
const mergeNoteBuckets = (
  into: NoteBuckets,
  from: NoteBuckets,
): NoteBuckets => ({
  notes: [...into.notes, ...from.notes],
  actions: [...into.actions, ...from.actions],
});

/**
 * Emit the accumulated buckets: every ordinary note, then every action.
 *
 * One call for the WHOLE dictation rather than one per chunk, which is the whole point --
 * see `applyFastStyle`.
 */
const renderNotes = (buckets: NoteBuckets): string => {
  const { notes, actions } = buckets;
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

  const rendered = parts.join("\n").trim();
  if (rendered) return rendered;

  // Both buckets empty. Every chunk reduced to nothing BEFORE classification -- filler,
  // self-corrections and symbol replacements left no sentence behind -- so there is nothing to
  // bullet, and the empty string is the honest answer.
  //
  // This path used to end in `toBullets(trimmed)`, the WHOLE transcript. `toBullets` asserts the
  // chunk size, so past the cap that assert threw, the caller's `try` turned it into "return
  // rawTranscript", and a dictation of nothing but filler came back as itself, unstyled.
  //
  // Not calling `toBullets` here is what closes that, and it is also why there is no argument to
  // get wrong: `toBullets` runs the transform chain this path has already run, so on an input
  // with no sentences left it returns "" whatever text it is handed. Measured over 11 inputs
  // that reach this branch -- all-filler bodies from one chunk to two past the cap, filler
  // around a sentence that is not an action, non-breaking-space and newline filler -- bulleting
  // the last chunk, the first chunk, or the empty string was non-empty in 0 of them. So the
  // argument could not have changed the output, and a bounded one would have been a false
  // invariant rather than a fix.
  return "";
};

/**
 * How the styled chunks of one tone are rejoined. A tone whose output is
 * line-structured rejoins on the same separator it uses internally, so the join
 * is invisible; the sentence-shaped tones rejoin on a space, which is what they
 * use between sentences already.
 */
// How a chunk's styled text meets the next chunk's. The NOTES tone is ABSENT because it
// does not go through `applyStyleToChunk` at all: `applyFastStyle` classifies every chunk and
// emits once, so there is no per-chunk output of the notes tone to join. Adding an entry here
// for it would be a lie about a path nothing takes.
const CHUNK_JOIN_BY_TONE: Readonly<Record<string, string | undefined>> = {
  [EMAIL_TONE_ID]: "\n\n",
  [BULLETS_TONE_ID]: "\n",
};

const applyStyleToChunk = (
  chunk: string,
  toneId: string,
  position: { isFirst: boolean; isLast: boolean; startsSentence: boolean },
): string => {
  switch (toneId) {
    // `POLISHED_TONE_ID` IS the string "default" (`tone.utils.ts:8`), so the
    // `case "default":` that used to sit beside this one was a second label for the
    // same value and could never be reached. Naming the constant only is what keeps
    // the value in one place.
    case POLISHED_TONE_ID:
      return toPolished(chunk, position.isLast, position.startsSentence);
    case EMAIL_TONE_ID:
      return toEmail(chunk, {
        liftGreeting: position.isFirst,
        liftClosing: position.isLast,
        isFinal: position.isLast,
        startsSentence: position.startsSentence,
      });
    case CHAT_TONE_ID:
      return toChat(chunk, position.isLast, position.startsSentence);
    case FORMAL_TONE_ID:
      return toFormal(chunk, position.isLast, position.startsSentence);
    case PROMPT_TONE_ID:
      return toPrompt(chunk, position.isLast, position.startsSentence);
    case BULLETS_TONE_ID:
      return toBullets(chunk, position.startsSentence);
    case CONCISE_TONE_ID:
      return toConcise(chunk, position.isLast, position.startsSentence);
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
 * a greeting off the front and a sign-off off the back — so it needed to be told
 * where its chunk sits for that reason.
 *
 * The terminator a chunk appends also has to be suppressed on a chunk that continues
 * into the next one, whichever tone produced it. That is the second reason a transform
 * takes `isLast`, and it is the reason `toPolished`, `toChat`, `toFormal`, `toConcise`,
 * `toPrompt` and `toEmail` all take it now.
 *
 * Not every transform is told, and saying so was the overstatement: `toBullets` is called
 * with the chunk alone. It appends no sentence terminator -- it emits one line per sentence
 * and joins them with newlines -- so there is nothing for `isLast` to suppress. The rule is
 * "every transform that appends a terminator", not "every transform".
 *
 * `toNotes` used to be the second name on that list. It is not called at all now: the notes
 * tone restructures the WHOLE dictation rather than each chunk, so `applyFastStyle` handles
 * it before `applyStyleToChunk` is reached and there is no `toNotes` to name here.
 */
// Weekday and month names are proper nouns in written English, and the API
// styles capitalize them ("Fix grammar, punctuation, and formatting"), so the
// local path has to as well or a short dictation that routes locally reads
// worse than the same text sent to the provider. "march", "may" and "august"
// are left out: they are ordinary words too ("we march first", "you may").
const CALENDAR_WORD_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|april|june|july|september|october|november|december)\b/gi;

const capitalizeCalendarWords = (text: string): string =>
  text.replace(CALENDAR_WORD_RE, (match) => capitalizeFirst(match));

// Words whose lowercase spelling is common enough that a dictionary term
// matching one of them must not be applied case-insensitively.
const COMMON_WORD_TERMS: ReadonlySet<string> = new Set([
  "it",
  "is",
  "us",
  "no",
  "so",
  "to",
  "in",
  "on",
  "at",
  "be",
  "as",
  "an",
  "or",
  "of",
  "my",
  "me",
  "he",
  "we",
  "do",
  "go",
  "if",
  "up",
  "off",
  "one",
  "all",
  "and",
  "the",
  "for",
  "you",
  "but",
  "not",
  "now",
  "new",
  "may",
  "data",
  "test",
  "app",
]);

export type FastStyleOptions = {
  /**
   * Canonical spellings from the user's dictionary. A term that appears with a
   * different casing in the output is rewritten to the dictionary's spelling.
   */
  dictionaryTerms?: readonly string[];
};

const applyDictionaryCasing = (
  text: string,
  terms: readonly string[] | undefined,
): string => {
  if (!text || !terms || terms.length === 0) return text;
  // Longest first, so a term that contains another is not half-rewritten.
  const candidates = terms
    .filter(
      (term) =>
        term.length >= 2 &&
        /[A-Z]/.test(term) &&
        /^[\p{L}\p{N}]/u.test(term) &&
        /[\p{L}\p{N}]$/u.test(term) &&
        // A term that is an ordinary lowercase word ("IT", "US", "No") would
        // rewrite every occurrence of that word. The dictionary is there to fix
        // spelling, not to recase the language.
        !COMMON_WORD_TERMS.has(term.toLowerCase()),
    )
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const term of candidates) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "gi"), (match) =>
      match === term ? match : term,
    );
  }
  return out;
};

/**
 * The written-form and dictionary passes run once, on the finished text, so a
 * phrase split across two chunks is still recognised as one phrase.
 */
const finalizeFastStyle = (
  styled: string,
  options: FastStyleOptions,
): string => {
  const withWrittenForms = normalizeSpokenForms(styled);
  const withCalendarCasing = capitalizeCalendarWords(withWrittenForms);
  // Dictionary terms run last, so the user's spelling outranks the built-in
  // casing rules for anything they have added a term for.
  return applyDictionaryCasing(withCalendarCasing, options.dictionaryTerms);
};

export const applyFastStyle = (
  rawTranscript: string,
  toneId: string | null,
  options: FastStyleOptions = {},
): string => {
  const trimmed = rawTranscript.trim();
  if (!trimmed) return trimmed;

  if (!toneId || toneId === VERBATIM_TONE_ID || toneId === "disabled") {
    return rawTranscript;
  }

  try {
    const chunks = splitIntoChunks(trimmed);

    // The notes tone is the one transform whose OUTPUT is a reordering, so it cannot be
    // applied per chunk and concatenated. `toNotes` used to split a chunk into ordinary
    // notes and actions and emit notes-then-actions for THAT chunk; applied per chunk, a
    // long dictation came out as
    //
    //     [chunk1 notes][chunk1 actions][chunk2 notes][chunk2 actions]
    //
    // so an action from an early chunk sat ABOVE ordinary notes from a later one, and the
    // same content reordered purely by crossing the cap. Measured before this change: an
    // action at 14961 characters and a note after it styled to
    // "- [ ] We need to ship the release today" followed by
    // "- The weather in Lagos has been unusually wet this week", where under the cap the
    // same two sentences give the notes first and the action last.
    //
    // So classify every chunk and emit once. The chunk cap still applies -- each chunk goes
    // through `classifyForNotes`, which asserts it -- and the `try` still catches a throw
    // from any chunk, so the raw transcript remains the answer when one fails.
    if (toneId === NOTES_TONE_ID) {
      const buckets = chunks.reduce<NoteBuckets>(
        (into, chunk) =>
          mergeNoteBuckets(
            into,
            classifyForNotes(chunk.text, chunk.startsSentence),
          ),
        { notes: [], actions: [] },
      );
      return finalizeFastStyle(renderNotes(buckets), options);
    }

    const lastIndex = chunks.length - 1;
    const styled = chunks
      .map((chunk, index) =>
        applyStyleToChunk(chunk.text, toneId, {
          isFirst: index === 0,
          isLast: index === lastIndex,
          startsSentence: chunk.startsSentence,
        }),
      )
      .join(CHUNK_JOIN_BY_TONE[toneId] ?? " ");
    return finalizeFastStyle(styled, options);
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
 * The built-in prose styles, the subset of [`FAST_STYLE_TONE_IDS`] whose local
 * transform only edits prose in place. The structured styles (email, bullets,
 * notes) are excluded from short-dictation routing because they restructure the
 * text, and restructuring is the part an LLM does better; they still take the
 * local transform when no LLM is configured.
 */
export const FAST_STYLE_PROSE_TONE_IDS: ReadonlySet<string> = new Set([
  POLISHED_TONE_ID,
  CHAT_TONE_ID,
  FORMAL_TONE_ID,
  PROMPT_TONE_ID,
  CONCISE_TONE_ID,
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
