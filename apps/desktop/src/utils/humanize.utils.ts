/**
 * Post-hoc scrubber that removes residual AI‑slop markers from LLM output.
 *
 * This is a **conservative safety net** — it mechanically fixes a small set
 * of well‑known markers without changing meaning or butchering legitimate text.
 * The primary de‑slopping should happen via the humanize.txt prompt artifact
 * loaded into the agent/post‑processing pipeline; this scrubber catches what
 * leaks through.
 */

// ── Banned markers with replacements ────────────────────────────────────

interface Replacement {
  pattern: RegExp;
  replace: string;
}

const replacements: Replacement[] = [
  // Em‑dashes → comma or space (context‑dependent)
  { pattern: /\s*—\s*/g, replace: ", " },
  { pattern: /\s*–\s*/g, replace: " – " },

  // Common slop phrases (whole‑word, case‑insensitive where applicable)
  { pattern: /\bdelve\b/gi, replace: "explore" },
  { pattern: /\bseamless\b/gi, replace: "smooth" },
  { pattern: /\bunlock\b/gi, replace: "enable" },
  { pattern: /\bleveraging\b/gi, replace: "using" },
  { pattern: /\butilize\b/gi, replace: "use" },
  { pattern: /\bUtilizes\b/g, replace: "uses" },
  { pattern: /\bUtilized\b/g, replace: "used" },
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
  /** If true, also normalize whitespace (collapse, trim). Default true. */
  normalizeWhitespace?: boolean;
}

/**
 * Apply the post‑hoc scrubber to a string of LLM‑generated text.
 *
 * Returns the cleaned text. If `normalizeWhitespace` is true (default),
 * runs a final pass to collapse multiple spaces/line breaks and trim.
 */
export const humanizeScrub = (
  text: string | null | undefined,
  options: HumanizeOptions = {},
): string => {
  if (!text) return "";

  const { normalizeWhitespace = true } = options;
  let result = text;

  for (const { pattern, replace } of replacements) {
    result = result.replace(pattern, replace);
  }

  // Clean up double spaces left by removed phrases
  result = result.replace(/\s{2,}/g, " ");

  if (normalizeWhitespace) {
    result = result.trim();
  }

  return result;
};