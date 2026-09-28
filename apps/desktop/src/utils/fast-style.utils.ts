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
 * - International-safe, length-guarded.
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

const truncateGuard = (text: string): string => {
  if (text.length <= MAX_INPUT_CHARS) return text;
  return text.slice(0, MAX_INPUT_CHARS);
};

const FILLER_RE = /\b(?:u[hm]+|er+|ah+|h?mm+)\b[,\s]*/gi;

// Conservative: only clear multi-word fillers that cannot be content. "like",
// "basically", "literally", "so", "well" and "actually" must not be deleted
// unconditionally ("I like ice cream", "literally impossible").
// "you know" is a pure discourse filler, so it goes anywhere. "I mean" is also
// ordinary English ("the mean of the data, I mean it statistically"), so it is
// only a filler when the speaker commas it off as a discourse marker.
const EXTRA_FILLER_RE = /(?:^|\s)you know\b[,\s]*/gi;
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

const CONTRACTION_RES: Array<[RegExp, string]> = Object.entries(
  CONTRACTION_MAP,
).map(([contraction, expansion]) => {
  const pattern = contraction.replace("'", "'?");
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

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9])/g;

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

const ensureSentencePunctuation = (sentence: string): string => {
  const trimmed = sentence.trim();
  if (!trimmed) return "";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

const splitIntoSentences = (text: string): string[] => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (/[.!?]/.test(normalized)) {
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

const fixCapitalizationAndPunctuation = (text: string): string => {
  const sentences = splitIntoSentences(text);
  if (sentences.length === 0) return text.trim();
  const isEnglishLike = /[a-zA-Z]/.test(text);
  if (!isEnglishLike) return text.trim();
  return sentences
    .map((s) => capitalizeFirst(ensureSentencePunctuation(s)))
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

const toPolished = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  if (!t) return t;
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);
  t = fixCapitalizationAndPunctuation(t);
  t = breakIntoParagraphs(t, 3);
  t = t.replaceAll("—", "-");
  return t;
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
  return trimmed.split(/\s+/).length <= maxWords || trimmed.length <= maxChars;
};

const splitEmailSections = (
  sentences: string[],
): { greeting: string; body: string[]; closing: string } => {
  const body = [...sentences];
  let greeting = "";
  let closing = "";

  const first = body.at(0);
  if (
    first &&
    EMAIL_GREETING_RE.test(first) &&
    isShortEnoughToLift(first, 4, 20)
  ) {
    greeting = first;
    body.shift();
  }

  const last = body.at(-1);
  if (last && EMAIL_CLOSING_RE.test(last) && isShortEnoughToLift(last, 5, 25)) {
    closing = last;
    body.pop();
  }

  return { greeting, body, closing };
};

const joinEmailBlocks = (blocks: string[]): string =>
  blocks
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const toEmail = (raw: string): string => {
  const polished = toPolished(truncateGuard(raw));
  const sentences = splitIntoSentences(polished);
  if (sentences.length === 0) return polished;

  const { greeting, body, closing } = splitEmailSections(sentences);
  const bodyText =
    body.length > 0 ? breakIntoParagraphs(body.join(" "), 2) : "";
  const joined = joinEmailBlocks([greeting, bodyText, closing]);

  return joined || polished;
};

const CHAT_CONNECTIVE_RE =
  /\b(?:furthermore|moreover|additionally|consequently)\b[,\s]+(\S)/gi;

const toChat = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);
  const sentences = splitIntoSentences(t);
  const cleaned = sentences
    .map((s) => deleteLeadingPhrase(s, CHAT_CONNECTIVE_RE))
    .map((s) => s.replace(/^[,.\s]+/, "").trim())
    .filter(Boolean);
  let joined = cleaned
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (joined && !/[.!?]$/.test(joined)) joined += ".";
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

const toFormal = (raw: string): string => {
  const t = expandContractions(toPolished(truncateGuard(raw)))
    .replace(INFORMAL_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return fixCapitalizationAndPunctuation(t);
};

const toPrompt = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);
  t = t.replace(/^(?:hey|hi|hello|so|well|um|uh)\b[,\s]*/i, "");
  t = t.replace(
    /^(?:can you|could you|would you|please|I need you to|I want you to|I need|I want)\b\s*/i,
    "",
  );
  const sentences = splitIntoSentences(t);
  const limited = sentences.slice(0, 3).join(" ").trim();
  let out = limited || t;
  if (!out) return guarded.trim();
  out = capitalizeFirst(out);
  if (!/[.!?]$/.test(out)) out += ".";
  return out;
};

const toBullets = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);

  const sentences = splitIntoSentences(t);
  if (sentences.length === 0) return t;

  const EDGE_CHARS = new Set([",", ";", ".", " ", "\t", "\n", "\r"]);
  // Scans inward from both ends. A pair of anchored character-class replaces
  // does the same job but backtracks, which Sonar flags on this path.
  const stripEdgePunctuation = (text: string): string => {
    let start = 0;
    let end = text.length;
    while (start < end && EDGE_CHARS.has(text[start])) start += 1;
    while (end > start && EDGE_CHARS.has(text[end - 1])) end -= 1;
    return text.slice(start, end);
  };

  const ideas: string[] = [];
  for (const s of sentences) {
    const parts = s.includes(";") ? s.split(";") : [s];
    for (const p of parts) {
      const trimmed = stripEdgePunctuation(p);
      if (trimmed.length > 2) ideas.push(trimmed);
    }
  }

  const source = ideas.length > 0 ? ideas : sentences;

  const bullets = source.map((idea) => {
    let out = idea.trim().replace(/^[•\-*]\s*/, "");
    out = capitalizeFirst(out.replace(/\.$/, "").trim());
    return `- ${out}`;
  });

  return bullets.join("\n");
};

const toConcise = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);
  t = deleteLeadingPhrase(t, HEDGING_RE);
  for (const [re, repl] of REDUNDANT_PHRASES) {
    t = t.replace(re, repl);
  }
  t = t.replace(/\s{2,}/g, " ").trim();
  return fixCapitalizationAndPunctuation(t);
};

const toNotes = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);
  const sentences = splitIntoSentences(t);
  if (sentences.length === 0) return t;

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

export const applyFastStyle = (
  rawTranscript: string,
  toneId: string | null,
): string => {
  const trimmed = rawTranscript.trim();
  if (!trimmed) return trimmed;

  if (!toneId || toneId === VERBATIM_TONE_ID || toneId === "disabled") {
    return rawTranscript;
  }

  const guarded =
    trimmed.length > MAX_INPUT_CHARS ? truncateGuard(trimmed) : trimmed;

  try {
    switch (toneId) {
      case POLISHED_TONE_ID:
      case "default":
        return toPolished(guarded);
      case EMAIL_TONE_ID:
        return toEmail(guarded);
      case CHAT_TONE_ID:
        return toChat(guarded);
      case FORMAL_TONE_ID:
        return toFormal(guarded);
      case PROMPT_TONE_ID:
        return toPrompt(guarded);
      case BULLETS_TONE_ID:
        return toBullets(guarded);
      case CONCISE_TONE_ID:
        return toConcise(guarded);
      case NOTES_TONE_ID:
        return toNotes(guarded);
      default:
        break;
    }

    switch (toneId) {
      case "light":
      case "casual":
      case "business":
        return toPolished(guarded);
      case "formal":
        return toFormal(guarded);
      case "punny":
        return toPolished(guarded);
      default:
        break;
    }

    // Custom tones: fast path cannot interpret free-form prompt, fallback to polished
    // to avoid hallucination. LLM path will handle custom prompts when configured.
    return toPolished(guarded);
  } catch {
    return rawTranscript;
  }
};

/**
 * Whether a local transform exists for this tone. Provider-agnostic by design:
 * the transforms are pure string operations, so every provider gets the same
 * result for the same input.
 */
export const canApplyFastStyle = (toneId: string | null): boolean => {
  if (!toneId) return false;
  if (toneId === VERBATIM_TONE_ID || toneId === "disabled") return false;
  return true;
};

export const FAST_STYLE_MAX_INPUT_CHARS = MAX_INPUT_CHARS;
