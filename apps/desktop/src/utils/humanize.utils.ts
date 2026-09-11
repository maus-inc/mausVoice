/**
 * Post-hoc scrubber that removes residual AI‑slop markers from LLM output.
 *
 * This is a **conservative safety net** — it mechanically fixes a small set
 * of well‑known markers without changing meaning or butchering legitimate text.
 * The primary de‑slopping should happen via the humanize prompt artifact
 * (`HUMANIZE_SKILL_TEXT` below, mirrored by `scripts/prompts/humanize.txt`)
 * loaded into the agent/post‑processing pipeline; this scrubber catches what
 * leaks through.
 */

// ── Humanize skill (prompt artifact) ─────────────────────────────────────

/**
 * The single shared source of truth for the "humanize" skill loaded into every
 * LLM text-producing pipeline (agent system prompt + AI post-processing).
 *
 * Kept in code (rather than read from `scripts/prompts/humanize.txt`) because
 * the desktop app cannot read the repo's `scripts/` directory at runtime, and
 * the skill must be a first-class component of prompt assembly that tests can
 * assert on. `scripts/prompts/humanize.txt` is the human-readable mirror for
 * the standalone Python prompt harness — the two MUST stay in sync.
 */
export const HUMANIZE_SKILL_TEXT = [
  "Humanize the text: remove AI-slop markers while preserving meaning, structure, and facts.",
  "Replace em-dashes (—) with commas, periods, or colons, or restructure the sentence.",
  `Replace "delve" with "explore"; "seamless" with "smooth"; "unlock" with "enable"; "game-changer"/"transformative" with the actual benefit; "leveraging" with "using"; "utilize" with "use"; "in order to" with "to"; "a wide range of" with "many"; "cutting-edge"/"state-of-the-art" with "modern"; "robust" with "reliable"; "realm" with "area"; "in terms of" remove or rephrase; "it is important to note that"/"it is worth mentioning that" remove or condense.`,
  "Write in plain, direct, active-voice language. One idea per sentence. Avoid hedging (may/might/could) unless the uncertainty is real. Avoid clichés, buzzwords, and corporate jargon. Prefer concrete examples over abstract claims.",
  "Do NOT alter code, data, or structured output (JSON, markdown tables, etc.) except the banned markers embedded in their text. Do NOT change meaning, factual accuracy, or technical specificity.",
].join("\n");

// ── Banned markers with replacements ────────────────────────────────────

interface Replacement {
  pattern: RegExp;
  replace: string;
}

// En‑dashes (U+2013) are deliberately NOT scrubbed anywhere: they are a
// legitimate range/compound separator (e.g. "1–3 sentences"), not an AI slop
// marker.
const replacements: Replacement[] = [
  // Common slop phrases (whole‑word, case‑insensitive)
  { pattern: /\bdelve\b/gi, replace: "explore" },
  { pattern: /\bseamless\b/gi, replace: "smooth" },
  { pattern: /\bunlock\b/gi, replace: "enable" },
  { pattern: /\bleveraging\b/gi, replace: "using" },
  { pattern: /\butilize\b/gi, replace: "use" },
  { pattern: /\butilizes\b/gi, replace: "uses" },
  { pattern: /\butilized\b/gi, replace: "used" },
  { pattern: /\butilizing\b/gi, replace: "using" },
  { pattern: /\bin order to\b/gi, replace: "to" },
  { pattern: /\ba wide range of\b/gi, replace: "many" },
  { pattern: /\bcutting-edge\b/gi, replace: "modern" },
  { pattern: /\blet's dive\b/gi, replace: "let's look" },

  // Remove common verbose hedges
  {
    pattern: /\bit is important to note that\b/gi,
    replace: "",
  },
  {
    pattern: /\bit is worth mentioning that\b/gi,
    replace: "",
  },
  {
    pattern: /\bit should be noted that\b/gi,
    replace: "",
  },
];

// ── Scrubber ─────────────────────────────────────────────────────────────

export interface HumanizeOptions {
  /** If true (default), trim leading/trailing whitespace from the result. */
  normalizeWhitespace?: boolean;
}

// ── Structure protection ─────────────────────────────────────────────────
//
// The scrubber runs on arbitrary Markdown assistant output. Replacing words
// or collapsing whitespace *inside* code or data corrupts it (renaming
// `lock.unlock()` to `lock.enable()`, flattening pretty-printed JSON), which
// would break the shared contract above ("Do NOT alter code, data, or
// structured output"). Text is therefore split into protected segments
// (fenced code blocks, inline code spans) and plain prose, and every
// transformation applies to prose only.

/**
 * Split text into alternating `{ protected, text }` segments at line
 * granularity. Every input line lands in exactly one block, so callers can
 * re-join the block texts with "\n" and get byte-identical structure.
 *
 * Implemented as a line scanner instead of one big regular expression: the
 * scanner is linear and auditably simple, where a regex over arbitrary LLM
 * text invites backtracking blowups.
 */
const splitProtectedSegments = (
  text: string,
): { protected: boolean; text: string }[] => {
  type Segment = { protected: boolean; text: string };
  const lineBlocks: Segment[] = [];
  let proseLines: string[] = [];
  let openFence: { lines: string[]; marker: string } | null = null;

  const flushProse = () => {
    if (proseLines.length > 0) {
      lineBlocks.push({ protected: false, text: proseLines.join("\n") });
      proseLines = [];
    }
  };

  for (const line of text.split("\n")) {
    const marker = fenceMarker(line);
    if (openFence === null && marker) {
      flushProse();
      openFence = { lines: [line], marker };
      continue;
    }
    if (openFence !== null) {
      openFence.lines.push(line);
      // A closing fence is marker-only (plus blanks). Lines with an info
      // string (e.g. ```python) inside an open fence are content; treating
      // them as closers would split the block and scrub its interior.
      if (
        marker &&
        FENCE_CLOSE_LINE.test(line) &&
        closesFence(marker, openFence.marker)
      ) {
        lineBlocks.push({ protected: true, text: openFence.lines.join("\n") });
        openFence = null;
      }
      continue;
    }
    proseLines.push(line);
  }
  flushProse();
  // Fail closed: an unterminated fence protects the rest of the text.
  if (openFence !== null) {
    lineBlocks.push({ protected: true, text: openFence.lines.join("\n") });
  }
  return lineBlocks;
};

// An opening fence is a line whose first non-blank characters are a backtick
// or tilde run of 3+; it carries an optional info string after the marker.
const fenceMarker = (line: string): string | null => {
  const match = /^[ \t]*(`{3,}|~{3,})/.exec(line);
  return match?.[1] ?? null;
};

// Closing fences are marker-only lines (CommonMark: no info string allowed).
// CRLF input keeps a trailing \r on every line after the "\n" split.
const FENCE_CLOSE_LINE = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?$/;

const closesFence = (marker: string, opener: string): boolean =>
  marker.startsWith(opener.charAt(0)) && marker.length >= opener.length;

/** End index of the inline code span starting at `from`, or -1. */
const findInlineCodeEnd = (text: string, from: number): number => {
  if (text[from] !== "`") return -1;
  let end = from;
  while (end < text.length && text[end] === "`") end++;
  const run = text.slice(from, end);
  const close = text.indexOf(run, end);
  // Inline code spans do not cross line breaks.
  if (close === -1 || text.slice(end, close).includes("\n")) return -1;
  return close + run.length;
};

/** Split a prose block on single-line inline code spans (no regex). */
const splitInlineCode = (
  text: string,
): { protected: boolean; text: string }[] => {
  const segments: { protected: boolean; text: string }[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const protectedEnd = findInlineCodeEnd(text, i);
    if (protectedEnd === -1) {
      i++;
      continue;
    }
    if (i > start) {
      segments.push({ protected: false, text: text.slice(start, i) });
    }
    segments.push({ protected: true, text: text.slice(i, protectedEnd) });
    i = protectedEnd;
    start = protectedEnd;
  }
  if (start < text.length) {
    segments.push({ protected: false, text: text.slice(start) });
  }
  return segments;
};

/**
 * Apply the post‑hoc scrubber to a string of LLM‑generated text.
 *
 * Returns the cleaned text. Code and structured content (fenced blocks,
 * inline code) pass through untouched. Whitespace normalization collapses
 * horizontal runs only — paragraph breaks and line structure are preserved.
 * If `normalizeWhitespace` is true (default), leading/trailing whitespace is
 * trimmed.
 */
export const humanizeScrub = (
  text: string | null | undefined,
  options: HumanizeOptions = {},
): string => {
  if (!text) return "";

  const { normalizeWhitespace = true } = options;

  const scrubProse = (prose: string): string => {
    // Em‑dashes → comma first (was first in the old ordered list). Horizontal
    // whitespace folds into the comma; a newline that followed the dash is
    // eaten and re-emitted unchanged so lists/paragraphs never merge.
    let out = prose.replace(
      /[ \t]*—[ \t]*(\r?\n)?/g, // NOSONAR: linear whitespace scan
      (_match, newline: string | undefined) => (newline ? `,${newline}` : ", "),
    );
    for (const { pattern, replace } of replacements) {
      out = out.replace(pattern, replace);
    }
    // Clean up double spaces left by removed phrases. Horizontal runs only:
    // newlines carry paragraph/list structure, and a line's leading indent
    // (indented code blocks, nested lists) is preserved verbatim. The
    // alternation tries the line-start run first, so indentation wins.
    return out.replace(
      /(^[ \t]+)|[ \t]{2,}/gm,
      (_run, indent: string | undefined) => indent ?? " ",
    );
  };

  let result = splitProtectedSegments(text)
    .map((block) => {
      if (block.protected) {
        return block.text;
      }
      // Inline-code spans inside a prose block concatenate without the
      // line-level "\n" (they never crossed a line boundary).
      return splitInlineCode(block.text)
        .map((segment) =>
          segment.protected ? segment.text : scrubProse(segment.text),
        )
        .join("");
    })
    .join("\n");

  if (normalizeWhitespace) {
    result = result.trim();
  }

  return result;
};
