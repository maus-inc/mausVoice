import { describe, expect, it } from "vitest";
import { theme } from "../theme";
import { inkSolid, surfaces, text } from "./palette";
import { selectedOutlineSx } from "./selection";

/** WCAG relative luminance (0–1) for the #hex / rgb() strings the tokens emit. */
const parseRgb = (color: string): [number, number, number] => {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgb) throw new Error(`Unsupported color: ${color}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
};

const linearize = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: string) => {
  const [r, g, b] = parseRgb(color).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrastRatio = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

describe("selectedOutlineSx", () => {
  it("uses the scheme-flipping palette variable for the ring, not a raw color", () => {
    const style = selectedOutlineSx(theme);
    // A raw `theme.palette` read would freeze in the light value and vanish
    // against dark card backgrounds — the original dark-mode bug. The ring
    // must reference the palette variable that resolves per active scheme
    // (its baked-in fallback is the light stroke for non-vars contexts).
    expect(style.boxShadow).toContain(
      `0 0 0 1px var(--app-palette-text-primary, ${text.light.primary})`,
    );
  });

  it("supports a custom ring width", () => {
    const style = selectedOutlineSx(theme, 2);
    expect(style.boxShadow).toContain(
      `0 0 0 2px var(--app-palette-text-primary, ${text.light.primary})`,
    );
  });

  it("keeps the ring visible against the card background in both schemes", () => {
    // The stroke token flips per scheme: dark ink in light mode, light text
    // in dark mode — never the raw primary color. (These are the same tokens
    // theme.ts maps into the per-scheme palettes.)
    const lightStroke = text.light.primary;
    const darkStroke = text.dark.primary;
    const lightCard = surfaces.light.level1;
    const darkCard = surfaces.dark.level1;

    expect(darkStroke).not.toBe(lightStroke);
    expect(darkStroke).not.toBe(inkSolid.base);
    // WCAG non-text contrast: >= 3:1 for UI component boundaries.
    expect(contrastRatio(lightStroke, lightCard)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(darkStroke, darkCard)).toBeGreaterThanOrEqual(3);
  });
});
