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

/**
 * Ordered, theme-specific activity ramps. Level 0 is the quiet empty-day
 * surface; levels 1–4 are relative positive-word quartiles. These are data
 * colors, kept separate from atmospheric gradients and brand chrome.
 */
export const activityHeatmap = {
  light: ["#D8D1C5", "#F1D1BE", "#EBAE8F", "#DE8059", "#B64726"],
  dark: ["#2D2D2F", "#4B2618", "#7A3A1F", "#BA5228", "#F0793B"],
} as const;

/** Optional static warm wash behind the dashboard's analytics region. */
export const activityStreakAccent = {
  light: "#B64726",
  dark: "#F0793B",
} as const;

export const activityAtmosphere = {
  light:
    "radial-gradient(ellipse at 52% 26%, rgba(182, 71, 38, 0.035) 0%, transparent 66%)",
  dark: "radial-gradient(ellipse at 52% 26%, rgba(240, 121, 59, 0.045) 0%, transparent 66%)",
} as const;

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
 * Resting glyph colour for the caption cluster.
 *
 * The glyph is dimmer at rest than body text, and the button it sits in is dimmer
 * too. Hover and press both bring the button back to full, so the cluster reads
 * as three peers at every step of the pointer's journey.
 */
export const captionButtonGlyph = {
  light: "rgba(0, 0, 0, 0.7)",
  dark: "rgba(255, 255, 255, 0.8)",
} as const;

/**
 * Caption-button hover fill, and the pressed fill behind it.
 *
 * Close is tinted exactly like minimize and maximize. That is deliberate and
 * not an oversight. In Windows and Linux a custom close button that paints
 * itself red advertises a destructive action, and this window intercepts
 * `CloseRequested` to hide to tray, so nothing is discarded. A neutral wash
 * keeps the cluster reading as three peers. `error.main` stays reserved for
 * actions that actually destroy data.
 */
export const captionButtonHover = {
  light: "rgba(0, 0, 0, 0.05)",
  dark: "rgba(255, 255, 255, 0.1)",
} as const;

export const captionButtonActive = {
  light: "rgba(0, 0, 0, 0.12)",
  dark: "rgba(255, 255, 255, 0.22)",
} as const;

/**
 * Resting opacity of each caption button, cleared by hover and press.
 *
 * Windows dims unfocused chrome rather than removing it, and a cluster that
 * vanished would take the only visible cue that the window has controls. This is
 * the per-button rest value and it is only half the story: the cluster's focus
 * dim is applied once on the wrapper, so the two multiply and a hovered button
 * on an unfocused window still renders dimmed.
 */
export const captionButtonRestOpacity = 0.8;

/**
 * The window wash, shared by the title bar and the navigation rail.
 *
 * Those two are the same material, so they have to be the same colour. This
 * token makes that structural instead of a coincidence: the rail used to carry
 * its own gradient while the bar carried a separate fill, so the two could be
 * retuned independently and leave a visible step where they met. The routed
 * content area deliberately does not use it; see `DESIGN.md`.
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
