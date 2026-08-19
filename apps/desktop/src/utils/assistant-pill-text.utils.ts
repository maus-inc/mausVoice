/**
 * Converts markdown text to pill-friendly plain text.
 *
 * The pill is a native canvas/Cairo/Direct2D surface with no markdown renderer.
 * This pure-TS pipeline strips/rewrites markdown constructs so assistant messages
 * display cleanly on all three platform pills without raw `**bold**`, `### headers`,
 * ```fences```, `-` bullets, or raw links.
 *
 * DESIGN DECISIONS
 * - Streaming-safe by re-processing: the converter is a single-pass scanner
 *   with no cross-call state (the fence `inFence` flag is per-invocation), so
 *   partial/streaming input never leaks a half-rendered fence or dangling
 *   bullet *into a single call's output*. It is NOT a chunk-append primitive:
 *   concatenating the outputs of arbitrary chunk boundaries can differ from
 *   converting the whole text (e.g. a link, code fence, or emphasis marker
 *   spanning a chunk boundary). The consumer therefore re-converts the full
 *   accumulated message on every sync — see OverlaySyncSideEffects.
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
// Zero-width word/asterisk boundaries so surrounding characters are not
// consumed ("hello *world* today" stays spaced) while *emphasized*. and
// (*emphasized*) still match. Intra-word stars like is*not* stay literal.
const ITALIC_RE = /(?<![\w*])\*(?!\*)([^*\n]+?)\*(?!\*)(?![\w*])/g;
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

type ScanResult = { out: string; next: number } | null;

type ScanHandler = (input: string, close: number, inner: string) => ScanResult;

/** Try each handler in order; return the first that applies. */
const dispatchScan = (
  handlers: ScanHandler[],
  input: string,
  close: number,
  inner: string,
): ScanResult => {
  for (const handler of handlers) {
    const result = handler(input, close, inner);
    if (result) return result;
  }
  return null;
};

/** ![alt](url) -> alt text. */
const scanImage = (input: string, close: number, inner: string): ScanResult => {
  if (input[close + 1] !== "(") return null;
  const endParen = input.indexOf(")", close + 2);
  if (endParen < 0) return null;
  return { out: inner, next: endParen + 1 };
};

/** [text](url) -> "text (url)" when short, else text. */
const scanLink = (input: string, close: number, inner: string): ScanResult => {
  if (input[close + 1] !== "(") return null;
  const endParen = input.indexOf(")", close + 2);
  if (endParen < 0) return null;
  const url = input.slice(close + 2, endParen);
  const cleaned = collapseWhitespace(inner);
  if (cleaned.includes(url) || cleaned.length > 50) {
    return { out: cleaned, next: endParen + 1 };
  }
  const combined = `${cleaned} (${url})`;
  return { out: combined.length > 60 ? cleaned : combined, next: endParen + 1 };
};

/** [text][label] -> text. */
const scanRefLink = (
  input: string,
  close: number,
  inner: string,
): ScanResult => {
  if (input[close + 1] !== "[") return null;
  const endLabel = input.indexOf("]", close + 2);
  if (endLabel < 0) return null;
  return { out: inner, next: endLabel + 1 };
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
    const isImage = i > 0 && input[i - 1] === "!";
    const open = i;
    if (isImage) {
      // Drop the leading '!' that precedes markdown images.
      out = out.slice(0, -1);
    }
    const close = input.indexOf("]", open + 1);
    if (close < 0) {
      out += input.slice(i);
      break;
    }
    const inner = input.slice(open + 1, close);

    const handlers: ScanHandler[] = isImage
      ? [scanImage]
      : [scanLink, scanRefLink];
    const handled = dispatchScan(handlers, input, close, inner);
    if (handled) {
      out += handled.out;
      i = handled.next;
      continue;
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

  // 5. Convert unordered list markers ("- item") to bullet symbols with a
  // manual scanner (no regex). "  - item" -> "• item".
  text = text
    .split("\n")
    .map((line) => {
      let j = 0;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j += 1;
      const marker = line[j];
      if (marker !== "-" && marker !== "*" && marker !== "+") return line;
      const spaceStart = j + 1;
      let k = spaceStart;
      while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
      if (k === spaceStart) return line;
      return "\u2022 " + line.slice(k);
    })
    .join("\n");

  // 6. Convert ordered list markers ("1. item") to plain numbers with a
  // manual scanner (no regex). "1.  item" -> "1. item".
  text = text
    .split("\n")
    .map((line) => {
      let j = 0;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j += 1;
      const digitStart = j;
      while (j < line.length && line[j] >= "0" && line[j] <= "9") j += 1;
      if (j === digitStart) return line;
      if (line[j] !== ".") return line;
      const digitEnd = j;
      j += 1;
      const spaceStart = j;
      while (j < line.length && (line[j] === " " || line[j] === "\t")) j += 1;
      if (j === spaceStart) return line;
      const numberText = line.slice(digitStart, digitEnd);
      return `${numberText}. ` + line.slice(j);
    })
    .join("\n");

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
