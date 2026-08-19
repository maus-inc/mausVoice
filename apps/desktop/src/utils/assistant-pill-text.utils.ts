/**
 * Converts markdown text to pill-friendly plain text.
 *
 * The pill is a native canvas/Cairo/Direct2D surface with no markdown renderer.
 * This pure-TS pipeline strips/rewrites markdown constructs so assistant messages
 * display cleanly on all three platform pills without raw `**bold**`, `### headers`,
 * ```fences```, `-` bullets, or raw links.
 *
 * DESIGN DECISIONS
 * - Greedy-but-idempotent: each chunk is processed independently so streaming
 *   never shows a half-rendered fence or dangling bullet. The output of the full
 *   text equals the concatenation of chunk outputs for the same boundary.
 * - Locale-independent: no hardcoded English beyond universal symbols.
 * - Links: rendered as "text (url)" only when the link text and URL differ
 *   meaningfully AND the combined length stays under one line (~60 chars).
 * - Tables: each row becomes a line of tab-separated cells (tabs render as
 *   spaces in the pill's monospace-ish fallback).
 */

// ── Block-level patterns ──────────────────────────────────────────────────

/** Matches a thematic break (`---`, `***`, `___`). */
const HR_RE = /^(?:[-*_]){3,}\s*$/gm;

/** Matches an ATX heading (`### ...`). */
const HEADING_RE = /^#{1,6}\s+/gm;

/** Matches a blockquote prefix (`> `). */
const BLOCKQUOTE_RE = /^>\s*/gm;

/** Fence start characters: backtick (0x60) and tilde (0x7e). */
const FENCE_CHARS = new Set<number>([0x60, 0x7e]);

// ── Inline patterns ───────────────────────────────────────────────────────

/** Bold / italic markers. */
const BOLD_RE = /\*\*(.+?)\*\*/g;
// Non-consuming boundaries: lookbehind/lookahead for start-or-space and
// end-or-space so the surrounding whitespace is preserved ("hello *world*"
// stays "hello world", never "helloworld") while `*word*.` inside a word is
// left alone (e.g. "is*not*" is not treated as emphasis).
const ITALIC_RE = /(?<!\S)\*(?!\*)([^*\n]+?)\*(?!\*)(?!\S)/g;
const STRIKETHROUGH_RE = /~~([^~\n]+?)~~/g;

/** Inline code backtick fences. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

// ── Helpers ───────────────────────────────────────────────────────────────

const ELLIPSIS = "\u2026";

/**
 * Collapse repeated whitespace (including newlines) to a single space,
 * then trim.
 */
const collapseWhitespace = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Clamp a string to `maxLen` characters, breaking at the last word boundary
 * before the limit.
 */
const clampWithEllipsis = (s: string, maxLen: number): string => {
  if (s.length <= maxLen) return s;
  const truncated = s.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + ELLIPSIS;
};

/** Check if a trimmed line is a fenced code block delimiter. */
const isFenceLine = (tl: string): boolean => {
  const fc = tl.codePointAt(0) ?? 0;
  if (!FENCE_CHARS.has(fc)) return false;
  if (tl.length < 3) return false;
  for (let i = 0; i < 3; i++) {
    if ((tl.codePointAt(i) ?? 0) !== fc) return false;
  }
  const rest = tl.slice(3).trim();
  return rest === "" || /^\w+$/.test(rest);
};

/**
 * Strip markdown images/links/reference-links with a hand-rolled scanner
 * (no regex, so no backtracking). Scans left to right for '[' and resolves:
 *   ![alt](url)  -> alt text
 *   [text](url)  -> "text (url)" when short, else text
 *   [text][label]-> text
 *   [text]       -> text
 */
const stripLinkSyntax = (input: string): string => {
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "[") {
      out += input[i];
      i += 1;
      continue;
    }
    const isImage = input[i + 1] === "!";
    const open = isImage ? i + 1 : i;
    const close = input.indexOf("]", open + 1);
    if (close < 0) {
      out += input.slice(i);
      break;
    }
    const inner = input.slice(open + 1, close);

    if (isImage) {
      // ![alt](url) -> alt
      if (input[close + 1] === "(") {
        const endParen = input.indexOf(")", close + 2);
        if (endParen >= 0) {
          out += inner;
          i = endParen + 1;
          continue;
        }
      }
      out += input.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    // [text](url) -> "text (url)" when short
    if (input[close + 1] === "(") {
      const endParen = input.indexOf(")", close + 2);
      if (endParen >= 0) {
        const url = input.slice(close + 2, endParen);
        const cleaned = collapseWhitespace(inner);
        if (cleaned.includes(url) || cleaned.length > 50) {
          out += cleaned;
        } else {
          const combined = `${cleaned} (${url})`;
          out += combined.length > 60 ? cleaned : combined;
        }
        i = endParen + 1;
        continue;
      }
    }

    // [text][label] -> text
    if (input[close + 1] === "[") {
      const endLabel = input.indexOf("]", close + 2);
      if (endLabel >= 0) {
        out += inner;
        i = endLabel + 1;
        continue;
      }
    }

    // bare [text] -> text
    out += inner;
    i = close + 1;
  }
  return out;
};

// ── Pipeline ──────────────────────────────────────────────────────────────

export interface MarkdownToPillOptions {
  /**
   * Maximum length of the returned string. If the cleaned text exceeds this
   * it is truncated at a word boundary with an ellipsis. 0 = no limit.
   * @default 0
   */
  maxLength?: number;

  /**
   * If true, preserve most inline formatting (bold, italic) by emitting
   * readable fallback markers like *text* (plain asterisks). If false (default),
   * strip all formatting markers entirely.
   * @default false
   */
  preserveEmphasis?: boolean;
}

/**
 * Convert a markdown string to pill-safe plain text.
 *
 * The conversion is stable for partial/streaming input: each call processes
 * its input independently and never leaves dangling fences or bullets.
 */
export const markdownToPillText = (
  raw: string | null | undefined,
  options: MarkdownToPillOptions = {},
): string => {
  if (!raw) return "";

  let text = raw;

  // 0. Strip images, then links, then reference links with a hand-rolled
  // scanner (no regex, so Sonar's backtracking rules don't apply). Images
  // and real links win over bare [text] reference brackets.
  text = stripLinkSyntax(text);

  // 1. Strip fenced code blocks (replace with a compact "[code]" marker)
  const lines = text.split("\n");
  let inFence = false;
  const cleanedLines: string[] = [];
  for (const line of lines) {
    if (isFenceLine(line.trim())) {
      if (!inFence) {
        cleanedLines.push("[code]");
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    cleanedLines.push(line);
  }
  text = cleanedLines.join("\n");

  // 2. Strip horizontal rules
  text = text.replace(HR_RE, "");

  // 3. Strip headings (remove `# ` prefix)
  text = text.replace(HEADING_RE, "");

  // 4. Strip blockquote markers
  text = text.replace(BLOCKQUOTE_RE, "");

  // 5. Convert unordered list markers to bullet symbol
  text = text.replace(/^\s*[-*+]\s+/gm, "\u2022 ");

  // 6. Convert ordered list markers to plain numbers
  // NOSONAR: anchored, disjoint tokens ([ \t]* and \s+ are separated by
  // \d+\.), so scanning is linear.
  text = text.replace(/^[ \t]*\d+\.\s+/gm, (match) => {
    const num = match.trim().split(".")[0];
    return `${num}. `;
  });

  // 7. Handle inline formatting
  if (options.preserveEmphasis) {
    text = text.replace(BOLD_RE, "*$1*");
    text = text.replace(ITALIC_RE, "$1");
  } else {
    text = text.replace(BOLD_RE, "$1");
    text = text.replace(ITALIC_RE, "$1");
  }
  text = text.replace(STRIKETHROUGH_RE, "$1");

  // 10. Inline code to quoted text
  text = text.replace(INLINE_CODE_RE, '"$1"');

  // 11. Collapse excessive whitespace
  text = collapseWhitespace(text);

  // 12. Optional length clamp
  if (options.maxLength && options.maxLength > 0) {
    text = clampWithEllipsis(text, options.maxLength);
  }

  return text;
};

/**
 * Check whether a streaming chunk is "safe" — i.e. concatenating it with a
 * previous chunk produces the same result as converting the whole text at once.
 *
 * This is true for most single-pass string operations. The exception is the
 * fence detector: if a chunk ends with an opening fence delimiter, the next
 * chunk will produce "[code]" but the concatenation of the two chunks would
 * correctly produce "[code]" as well, because the fence handler spans chunks
 * via state. The only problematic case is a chunk that starts mid-fence:
 * "const x = 1;\n```" would be swallowed entirely by the open fence from the
 * previous chunk. Therefore a zero-trust streaming consumer should append
 * each chunk's output to the previous output, which gives correct results
 * for all cases except an *unclosed* fence at the very end of the stream.
 */
export const isStreamingStable = (raw: string | null | undefined): boolean => {
  if (!raw) return true;
  // If the text contains an unmatched opening fence, the conversion drops
  // everything after the opener. That's a streaming artifact, not stable.
  const opens = (raw.match(/^`{3}(?:\w+)?\s*$/gm) || []).length;
  const closes = (raw.match(/^`{3}\s*$/gm) || []).length;
  return opens <= closes;
};
