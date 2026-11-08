/** Advance widths in em from the bundled GeistPixel-Square font.
 * Regenerate these values if the font file changes. Unknown glyphs use a
 * conservative fallback because they may come from a different font.
 */
const ASCII_ADVANCES = [
  0.38, 0.266, 0.304, 0.494, 0.646, 0.76, 0.57, 0.152, 0.38, 0.38, 0.418, 0.532,
  0.19, 0.38, 0.19, 0.418, 0.57, 0.494, 0.646, 0.608, 0.684, 0.57, 0.646, 0.57,
  0.646, 0.646, 0.266, 0.228, 0.532, 0.532, 0.532, 0.532, 0.836, 0.608, 0.646,
  0.684, 0.684, 0.608, 0.57, 0.684, 0.684, 0.228, 0.608, 0.608, 0.57, 0.76,
  0.646, 0.684, 0.608, 0.76, 0.646, 0.646, 0.608, 0.684, 0.608, 0.912, 0.608,
  0.532, 0.684, 0.342, 0.418, 0.342, 0.418, 0.532, 0.266, 0.57, 0.57, 0.532,
  0.57, 0.532, 0.38, 0.608, 0.57, 0.38, 0.342, 0.532, 0.38, 0.76, 0.57, 0.532,
  0.57, 0.57, 0.456, 0.494, 0.38, 0.532, 0.494, 0.76, 0.494, 0.532, 0.57, 0.418,
  0.228, 0.418, 0.57,
] as const;

const SYMBOL_ADVANCES: Record<string, number> = {
  "⇧": 0.76,
  "←": 0.76,
  "→": 0.76,
  "↑": 0.684,
  "↓": 0.684,
};

export const geistPixelTextWidth = (
  text: string,
  letterSpacing: number,
): number => {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    const advance =
      code >= 32 && code <= 126
        ? ASCII_ADVANCES[code - 32]
        : (SYMBOL_ADVANCES[character] ?? 1.2);
    width += advance + letterSpacing;
  }
  return width;
};
