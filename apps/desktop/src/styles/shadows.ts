import { accent, darkInk, highlight, ink } from "./palette";

/**
 * Sigma-style layered surfaces:
 * - 2px inner highlight from the top (emboss)
 * - soft multi-stop drop shadow below (premium lift)
 *
 * Both schemes share one structure — the same stop geometry with
 * mode-tuned alphas — so the layered language reads the same in light and
 * dark. Light shadows are tinted with the warm `ink` so they sit on cream
 * instead of greying it out; dark shadows stay neutral black.
 *
 * Light-mode rationale (A14 insets — kept; A16 drops — mirrored from dark):
 * The inset emboss is A14's compromise between flat (level1 #FDFBF8 on
 * level0 #F5F2ED) and contained (inkSolid.base #1A1712) buttons:
 * - rest 0.42 (1px crisp) + 0.14 (2px halo): visible on flat without a thick
 *   white band; on dark contained blends to ~rgb122 vs previous ~rgb191 at
 *   0.72, closer to dark's refined ~rgb49 at 0.08.
 * - hover 0.58/0.20: slightly stronger lift than rest, analogue to dark
 *   0.12/0.05.
 * - active (pressed) ink(0.07) + highlight(0.18) + outer contact: subtle
 *   inner dark inset suggests press without muddy interior; dark uses
 *   darkInk(0.45)+highlight(0.04) heavier because near-black hides more.
 * - selected 0.18/0.06: on the dark selected bg (#1A1712) distinct but not
 *   engraved.
 * The drop stops mirror dark's geometry 1:1 — contact 1px/2px, mid 8px/20px,
 * ambient 18px/40px (hover 2/4, 12/28, 28/56; selected 1/2, 10/24) — with
 * warm ink at roughly a third of dark's alpha, so light surfaces carry the
 * same layered lift without greying the cream; selected runs heavier because
 * it marks the active item. The state ramp tracks dark's: hover > rest,
 * active collapses to contact-only, selected is heaviest.
 */
export const premiumSurface = {
  light: {
    rest: `
      inset 0 1px 0 ${highlight(0.42)},
      inset 0 2px 0 ${highlight(0.14)},
      0 1px 2px ${ink(0.1)},
      0 8px 20px ${ink(0.12)},
      0 18px 40px ${ink(0.1)}
    `,
    hover: `
      inset 0 1px 0 ${highlight(0.58)},
      inset 0 2px 0 ${highlight(0.2)},
      0 2px 4px ${ink(0.12)},
      0 12px 28px ${ink(0.16)},
      0 28px 56px ${ink(0.13)}
    `,
    active: `
      inset 0 2px 3px ${ink(0.07)},
      inset 0 1px 0 ${highlight(0.18)},
      0 1px 2px ${ink(0.1)}
    `,
    selected: `
      inset 0 1px 0 ${highlight(0.18)},
      inset 0 2px 0 ${highlight(0.06)},
      0 1px 2px ${ink(0.2)},
      0 10px 24px ${ink(0.26)}
    `,
  },
  dark: {
    rest: `
      inset 0 1px 0 ${highlight(0.08)},
      inset 0 2px 0 ${highlight(0.03)},
      0 1px 2px ${darkInk(0.35)},
      0 8px 20px ${darkInk(0.35)},
      0 18px 40px ${darkInk(0.28)}
    `,
    hover: `
      inset 0 1px 0 ${highlight(0.12)},
      inset 0 2px 0 ${highlight(0.05)},
      0 2px 4px ${darkInk(0.4)},
      0 12px 28px ${darkInk(0.42)},
      0 28px 56px ${darkInk(0.35)}
    `,
    active: `
      inset 0 2px 4px ${darkInk(0.45)},
      inset 0 1px 0 ${highlight(0.04)},
      0 1px 2px ${darkInk(0.35)}
    `,
    selected: `
      inset 0 1px 0 ${highlight(0.14)},
      inset 0 2px 0 ${highlight(0.05)},
      0 1px 2px ${darkInk(0.4)},
      0 10px 24px ${darkInk(0.45)}
    `,
  },
} as const;

/**
 * The accent CTA (variant "chrome") keeps the machined emboss but casts its
 * drop with the accent instead of neutral ink — the one colored lift in the
 * language.
 */
export const accentSurface = {
  light: `
    inset 0 1px 0 ${highlight(0.28)},
    inset 0 2px 0 ${highlight(0.1)},
    0 6px 16px rgba(${accent.light.rgb}, 0.35)
  `,
  dark: `
    inset 0 1px 0 ${highlight(0.28)},
    inset 0 2px 0 ${highlight(0.1)},
    0 6px 16px rgba(${accent.dark.rgb}, 0.35)
  `,
} as const;

/**
 * Frameless title bar chrome. Same structure in both schemes: a machined rim
 * on the bottom edge (inset, catching light) + one soft drop so the bar
 * floats above the canvas. Light uses a stronger rim alpha because
 * white-on-cream needs more to register against content scrolling under the
 * translucent bar.
 */
export const titleBarShadow = {
  light: `inset 0 -1px 0 ${highlight(0.3)}, 0 10px 28px ${ink(0.14)}`,
  dark: `inset 0 -1px 0 ${highlight(0.04)}, 0 10px 28px ${darkInk(0.35)}`,
} as const;

/**
 * Compact switch chrome: 1px top rim + contact drop on the thumb, inset
 * well on the track. Same geometry in both schemes; alphas follow
 * premiumSurface (light warm ink, dark neutral).
 */
export const switchThumb = {
  light: `inset 0 1px 0 ${highlight(0.42)}, 0 1px 2px ${ink(0.18)}`,
  dark: `inset 0 1px 0 ${highlight(0.12)}, 0 1px 2px ${darkInk(0.45)}`,
} as const;

export const switchTrack = {
  light: `inset 0 1px 2px ${ink(0.12)}`,
  lightChecked: `inset 0 1px 2px ${ink(0.28)}`,
  dark: `inset 0 1px 2px ${darkInk(0.45)}`,
  darkChecked: `inset 0 1px 2px ${darkInk(0.35)}`,
} as const;

/**
 * 1px translucent hairline used instead of a shadow to separate faces
 * (DESIGN.md: "borders over shadows"). `strength` picks how present it is.
 */
export const hairline = {
  light: (alpha = 0.06) => `1px solid ${ink(alpha)}`,
  dark: (alpha = 0.06) => `1px solid ${highlight(alpha)}`,
} as const;

/** One layer of a box-shadow token. */
export type ShadowLayer = {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  color: string;
};

const SHADOW_LAYER_RE =
  // NOSONAR (2): strict, unit-tested parser (shadows.test.ts). The optional
  // spread-radius group cannot nest with the required groups and tokens are
  // anchored, so scanning is linear; splitting risks silent token drift.
  /(inset\s+)?(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?\s+(-?\d+(?:\.\d+)?)(?:px)?(?:\s+(-?\d+(?:\.\d+)?)(?:px)?)?\s+rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g; // NOSONAR: anchored token parser

/**
 * Parses a shadow token into its layers. The token format is deliberately
 * constrained to `rgba()` colors: anything the parser cannot fully consume
 * raises, so tuning a token into an unsupported syntax (hex, `var()`,
 * `color-mix`…) fails loudly in tests instead of silently dropping layers.
 */
export const parseShadowLayers = (token: string): ShadowLayer[] => {
  const layers: ShadowLayer[] = [];
  for (const match of token.matchAll(SHADOW_LAYER_RE)) {
    const r = Number(match[6]);
    const g = Number(match[7]);
    const b = Number(match[8]);
    const alpha = Number(match[9]);
    layers.push({
      inset: match[1] !== undefined,
      offsetX: Number(match[2]),
      offsetY: Number(match[3]),
      blur: Number(match[4]),
      spread: Number(match[5] ?? 0),
      r,
      g,
      b,
      alpha,
      color: `rgba(${r}, ${g}, ${b}, ${alpha})`,
    });
  }
  const unconsumed = token.replace(SHADOW_LAYER_RE, "").replace(/[\s,]+/g, "");
  if (unconsumed) {
    throw new Error(
      `Unsupported shadow token format (only rgba() layers are supported): "${token.trim()}"`,
    );
  }
  return layers;
};
