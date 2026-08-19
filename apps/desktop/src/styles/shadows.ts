import { darkInk, highlight, ink } from "./palette";

/**
 * Sigma-style layered surfaces:
 * - 2px inner highlight from the top (emboss)
 * - soft multi-stop drop shadow below (premium lift)
 *
 * Light shadows are tinted with the warm `ink` so they sit on cream instead of
 * greying it out; dark shadows stay neutral black.
 *
 * Light-mode rationale (tuned 2026-08, A14 — keep in sync with DESIGN.md):
 * Shares the same token across flat (level1 #FDFBF8 on level0 #F5F2ED) and
 * contained (inkSolid.base #1A1712) buttons, so values are a compromise
 * between visibility on near-white and subtlety on near-black.
 * - rest 0.42 (1px crisp) + 0.14 (2px halo): visible on flat without a thick
 *   white band; on dark contained blends to ~rgb122 vs previous ~rgb191 at
 *   0.72, closer to dark's refined ~rgb49 at 0.08.
 * - hover 0.58/0.20: slightly stronger lift than rest, analogue to dark
 *   0.12/0.05.
 * - active (pressed) ink(0.07) + highlight(0.18) + outer 0.06: subtle inner
 *   dark inset suggests press without muddy interior; dark uses
 *   darkInk(0.45)+highlight(0.04) heavier because near-black hides more.
 * - selected 0.18/0.06 + outer 0.18/0.22: on dark selected bg (#1A1712)
 *   distinct but not engraved; outer drop-shadow alphas unchanged (A16 will
 *   evolve them). Only insets are tuned here — keep token shape stable.
 */
export const premiumSurface = {
  light: {
    rest: `
      inset 0 1px 0 ${highlight(0.42)},
      inset 0 2px 0 ${highlight(0.14)},
      0 1px 2px ${ink(0.04)},
      0 6px 16px ${ink(0.08)},
      0 14px 32px ${ink(0.06)}
    `,
    hover: `
      inset 0 1px 0 ${highlight(0.58)},
      inset 0 2px 0 ${highlight(0.2)},
      0 2px 4px ${ink(0.05)},
      0 10px 24px ${ink(0.12)},
      0 22px 44px ${ink(0.1)}
    `,
    active: `
      inset 0 2px 3px ${ink(0.07)},
      inset 0 1px 0 ${highlight(0.18)},
      0 1px 2px ${ink(0.06)}
    `,
    selected: `
      inset 0 1px 0 ${highlight(0.18)},
      inset 0 2px 0 ${highlight(0.06)},
      0 1px 2px ${ink(0.18)},
      0 8px 20px ${ink(0.22)}
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

export const titleBarShadow = {
  light: `0 1px 0 ${highlight(0.7)}, 0 8px 24px ${ink(0.06)}`,
  dark: `inset 0 -1px 0 ${highlight(0.04)}, 0 10px 28px ${darkInk(0.35)}`,
} as const;

/**
 * 1px translucent hairline used instead of a shadow to separate faces
 * (DESIGN.md: "borders over shadows"). `strength` picks how present it is.
 */
export const hairline = {
  light: (alpha = 0.06) => `1px solid ${ink(alpha)}`,
  dark: (alpha = 0.06) => `1px solid ${highlight(alpha)}`,
} as const;
