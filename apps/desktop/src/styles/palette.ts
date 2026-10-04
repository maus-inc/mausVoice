/**
 * Raw colour tokens for the surface ladder.
 *
 * Two deliberately different neutrals so each scheme has a temperature of its
 * own instead of one being an inversion of the other:
 *
 * - **light** is a warm cream-paper ladder,
 * - **dark** is a neutral onyx ladder with the blue cast removed.
 *
 * Neither end touches pure `#000` / `#fff` (DESIGN.md), and elevation is read
 * from luminance, not shadow. Everything tinted — hairlines, shadows, the
 * contained CTA, selection fills — is derived from `ink()` / `highlight()`
 * here rather than re-typed as a literal at the call site.
 */

/** Warm near-black the light scheme is tinted from. */
const LIGHT_INK = "26, 23, 18";
/** Neutral black the dark scheme casts its shadows with. */
const DARK_INK = "0, 0, 0";
/** Soft off-white used for dark-scheme text and inner highlights. */
const LIGHT_TEXT = "242, 241, 238";

export const surfaces = {
  light: {
    /** App canvas. */
    level0: "#F5F2ED",
    /** Surface: cards, dialogs, title bar. Brightest tier, still off-white. */
    level1: "#FDFBF8",
    /** Raised: inputs, hovered rows, segmented tracks. */
    level2: "#ECE8E1",
    /** Elevated: pressed states, dividers-as-fills. */
    level3: "#E0DBD2",
  },
  dark: {
    level0: "#0C0C0D",
    level1: "#161617",
    level2: "#1F1F21",
    level3: "#2A2A2C",
  },
} as const;

const hexToRgb = (hex: string) => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
};

/**
 * A surface tier at partial opacity, for backdrop-filtered chrome that has to
 * let the desktop through. Built from the same hex as the opaque tier so the
 * translucent and solid faces can never drift apart.
 */
export const surfaceAlpha = (hex: string, alpha: number) =>
  `rgba(${hexToRgb(hex)}, ${alpha})`;

/** Light-scheme ink at a given alpha — hairlines, shadows, scrollbars. */
export const ink = (alpha: number) => `rgba(${LIGHT_INK}, ${alpha})`;

/** Dark-scheme shadow ink at a given alpha. */
export const darkInk = (alpha: number) => `rgba(${DARK_INK}, ${alpha})`;

/** Inner top highlight (the "emboss") shared by both schemes. */
export const highlight = (alpha: number) => `rgba(255, 255, 255, ${alpha})`;

/** Dark-scheme hairlines and inverted text at a given alpha. */
export const onDark = (alpha: number) => `rgba(${LIGHT_TEXT}, ${alpha})`;

/**
 * Solid inks. `base` is the light-mode primary/CTA; `raised` / `pressed` are
 * its hover and active steps, kept as solids so they can sit on any tier.
 */
export const inkSolid = {
  base: "#1A1712",
  raised: "#282420",
  pressed: "#100E0B",
} as const;

/** Solid off-white counterparts for the dark scheme's inverted CTA. */
export const chalkSolid = {
  base: "#FFFFFF",
  raised: "#F2F0EC",
  pressed: "#FFFFFF",
} as const;

/** Text ramps. Neither ramp bottoms out at pure black or tops out at pure white. */
export const text = {
  light: {
    primary: inkSolid.base,
    secondary: ink(0.62),
    disabled: ink(0.36),
  },
  dark: {
    primary: `rgb(${LIGHT_TEXT})`,
    secondary: onDark(0.64),
    disabled: onDark(0.38),
  },
} as const;

/**
 * Quiet silver/ink chrome accent — never hue-blue.
 * Used for focus rings, selection wash, segmented chrome, sliders.
 * Switches use ink/chalk (grey-black), not this metal.
 */
export const accent = {
  light: { rgb: "107, 103, 96", main: "#6B6760" },
  dark: { rgb: "196, 192, 184", main: "#C4C0B8" },
} as const;

/**
 * Close-button hover.
 *
 * Deliberately faint. The main window intercepts `CloseRequested` and hides to
 * tray, so closing the window discards nothing, and a full destructive fill
 * would be claiming an outcome that does not happen. `error.main` stays
 * reserved for actions that actually destroy data.
 */
export const dangerHoverSoft = "rgba(232, 77, 77, 0.14)";

/**
 * The window wash, shared by the title bar, the navigation rail and the routed
 * content panel.
 *
 * Those three are the same material, so they have to be the same colour. This
 * token makes that structural instead of a coincidence: the rail used to carry
 * its own gradient while the bar carried a separate fill, so the two could be
 * retuned independently and leave a visible step where they met.
 *
 * One tier of lift at the top settling back into the canvas, so light reads as
 * falling from the top of the window. Built from the surface ladder rather than
 * from hexes, so it cannot drift off `level0`.
 */
export const chromeWash = {
  light: `linear-gradient(180deg, ${surfaceAlpha(surfaces.light.level1, 0.7)} 0%, ${surfaceAlpha(surfaces.light.level0, 0.35)} 100%)`,
  dark: `linear-gradient(180deg, ${surfaceAlpha(surfaces.dark.level2, 0.55)} 0%, ${surfaceAlpha(surfaces.dark.level0, 0.2)} 100%)`,
} as const;

/** Sanctioned overlay-on-screenshot alphas (pill overlay). */
export const overlayOnDark = {
  text: "rgba(242, 241, 238, 0.92)",
  muted: "rgba(242, 241, 238, 0.5)",
  hairline: "rgba(242, 241, 238, 0.2)",
  wash: "rgba(242, 241, 238, 0.06)",
} as const;
