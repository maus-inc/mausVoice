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

const FILLER_RE = /\b(?:um+|uh+|er+|ah+|hmm+|mm+|mmm+)\b[,\s]*/gi;

// Conservative: only clear multi-word fillers. "like", "basically", "literally",
// "so", "well", "actually" can be content ("I like ice cream", "literally impossible")
// and must not be deleted unconditionally.
const EXTRA_FILLER_RE = /(?:^|\s)(?:you know|I mean)\b[,\s]*/gi;
const EXTRA_FILLER_COMMA_RE = /(?:^|\s)(?:so|well)\s*,\s*/gi;

const REPEATED_WORD_RE = /\b(\w+)\s+\1\b/gi;

// Self-correction: "X, actually, Y" -> keep Y. Require comma after marker
// where ambiguous (no, -> no,). Limit to 60 chars to avoid backtracking.
const SELF_CORRECTION_PRECISE_RE =
  /[^.!?]{1,60},\s*(?:actually|no,|I mean|or rather)\s*,?\s*/gi;

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
  return [new RegExp(`\\b${pattern}\\b`, "gi"), expansion];
});

// Conservative hedging: only clear meta-commentary, not words that change
// meaning like "rather" in "I would rather not go" or "maybe" as content.
const HEDGING_RE = /\b(?:I think|I guess|in my opinion|sort of|kind of)\b\s*/gi;

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
  out = out.replace(/^(?:so|well|yeah|okay|ok)\b[,\s]*/i, "");
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
  t = t.replace(/—/g, "-");
  return t;
};

const toEmail = (raw: string): string => {
  const guarded = truncateGuard(raw);
  const polished = toPolished(guarded);
  const sentences = splitIntoSentences(polished);
  if (sentences.length === 0) return polished;

  const greetingRe = /^(?:hi|hello|hey|dear)\b/i;
  const closingRe = /\b(?:thanks|thank you|best|regards|sincerely|cheers)\b/i;

  let greeting = "";
  let bodySentences = [...sentences];
  let closing = "";

  if (sentences.length >= 1 && greetingRe.test(sentences[0])) {
    const first = sentences[0];
    const wordCount = first.trim().split(/\s+/).length;
    if (wordCount <= 4 || first.length <= 20) {
      greeting = first;
      bodySentences = sentences.slice(1);
    }
  }

  if (
    bodySentences.length >= 1 &&
    closingRe.test(bodySentences[bodySentences.length - 1])
  ) {
    const last = bodySentences[bodySentences.length - 1];
    const wordCount = last.trim().split(/\s+/).length;
    if (wordCount <= 5 || last.length <= 25) {
      closing = last;
      bodySentences = bodySentences.slice(0, -1);
    }
  }

  const body =
    bodySentences.length > 0
      ? breakIntoParagraphs(bodySentences.join(" "), 2)
      : "";

  const parts: string[] = [];
  if (greeting) parts.push(greeting);
  if (body) {
    if (parts.length > 0) parts.push("", body);
    else parts.push(body);
  }
  if (closing) {
    if (parts.length > 0) parts.push("", closing);
    else parts.push(closing);
  }

  if (parts.length === 0) return body || polished;

  return parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const toChat = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = guarded.trim();
  t = applySymbolReplacements(t);
  t = fixSelfCorrections(t);
  t = removeFillerWords(t, true);
  const sentences = splitIntoSentences(t);
  const cleaned = sentences
    .map((s) =>
      s
        .replace(
          /\b(?:furthermore|moreover|additionally|consequently)\b[,\s]*/gi,
          "",
        )
        .trim(),
    )
    .filter(Boolean)
    .map((s) => s.replace(/^[,.\s]+/, "").trim())
    .filter(Boolean);
  let joined = cleaned
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (joined && !/[.!?]$/.test(joined)) joined += ".";
  return joined;
};

const toFormal = (raw: string): string => {
  const guarded = truncateGuard(raw);
  let t = toPolished(guarded);
  for (const [re, expansion] of CONTRACTION_RES) {
    t = t.replace(re, (match) => {
      const isCapitalized = match[0] === match[0].toUpperCase();
      return isCapitalized ? capitalizeFirst(expansion) : expansion;
    });
  }
  t = t
    .replace(/\b(?:gonna|wanna|gotta|kinda|sorta|yeah|yep|nope)\b/gi, "")
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

  const ideas: string[] = [];
  for (const s of sentences) {
    if (s.includes(";")) {
      const parts = s.split(/;\s*/);
      for (const p of parts) {
        const trimmed = p.trim().replace(/^[,\s]+|[,\s]+$/g, "");
        if (trimmed.length > 2) ideas.push(trimmed);
      }
    } else {
      const trimmed = s.trim().replace(/^[,\s]+|[,\s]+$/g, "");
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
  t = t.replace(HEDGING_RE, "");
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
  _toneConfig?: unknown,
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

export const canApplyFastStyle = (toneId: string | null): boolean => {
  if (!toneId) return false;
  if (toneId === VERBATIM_TONE_ID || toneId === "disabled") return false;
  return true;
};

export const canApplyFastStyleForProvider = (
  _provider: string | null,
  toneId: string | null,
): boolean => {
  return canApplyFastStyle(toneId);
};

export const measureFastStyle = (
  raw: string,
  toneId: string | null,
  _toneConfig?: unknown,
): { result: string; durationMs: number } => {
  const start = performance.now();
  const result = applyFastStyle(raw, toneId);
  const durationMs = performance.now() - start;
  return { result, durationMs };
};

export const FAST_STYLE_MAX_INPUT_CHARS = MAX_INPUT_CHARS;
