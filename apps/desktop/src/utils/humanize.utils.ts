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

const replacements: Replacement[] = [
  // Em‑dashes → comma (context‑dependent). \s* around a fixed literal is at
  // most O(n) ambiguity for a fixed replacement; the two quantifiers cannot
  // nest. En‑dashes (U+2013) are deliberately NOT scrubbed: they are a
  // legitimate range/compound separator (e.g. "1–3 sentences"), not an AI
  // slop marker.
  { pattern: /\s*—\s*/g, replace: ", " }, // NOSONAR: linear whitespace split

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
