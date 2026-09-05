export const countWords = (text: string): number => {
  const words = text.trim().split(/\s+/);
  return words
    .filter((word) => word.length > 0)
    .reduce((count, word) => {
      return count + Math.ceil(word.length / 100);
    }, 0);
};

/**
 * First Unicode code point of `text`, or `0` when empty.
 *
 * Prefer `codePointAt` over `charCodeAt` so non-BMP characters (emoji / astral
 * planes) are not misread as a high-surrogate unit. The `?? 0` fallback covers
 * the empty-string case where `codePointAt` returns `undefined`.
 *
 * Requires a runtime with `String.prototype.codePointAt` (Node engines >= 20
 * in this monorepo's root package.json).
 */
export const codePointOf = (text: string): number => text.codePointAt(0) ?? 0;
