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

/**
 * True for non-printable controls that can break a single log line:
 * C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F).
 */
export const isLogBreakingControlCode = (code: number): boolean =>
  code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);

/**
 * True when the first code point of `text` is a log-breaking control.
 * Empty input is not a control (avoids treating codePointOf("") === 0 as U+0000).
 */
export const isLogBreakingControl = (text: string): boolean =>
  text.length > 0 && isLogBreakingControlCode(codePointOf(text));

/**
 * Drops every trailing character that appears in `characters`.
 *
 * A regex such as `/[.,!?;:]+$/` backtracks super-linearly on a long run of
 * the same character, which matters here because the input is transcript text.
 * Walking back from the end is linear and gives the same result.
 */
export const stripTrailingCharacters = (
  value: string,
  characters: string,
): string => {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1] as string)) {
    end -= 1;
  }
  return value.slice(0, end);
};
