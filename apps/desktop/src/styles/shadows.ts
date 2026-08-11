import { darkInk, highlight, ink } from "./palette";

/**
 * Sigma-style layered surfaces:
 * - 2px inner highlight from the top (emboss)
 * - soft multi-stop drop shadow below (premium lift)
 *
 * Light shadows are tinted with the warm `ink` so they sit on cream instead of
 * greying it out; dark shadows stay neutral black.
 */
export const premiumSurface = {
  light: {
    rest: `
      inset 0 1px 0 ${highlight(0.72)},
      inset 0 2px 0 ${highlight(0.28)},
      0 1px 2px ${ink(0.04)},
      0 6px 16px ${ink(0.08)},
      0 14px 32px ${ink(0.06)}
    `,
    hover: `
      inset 0 1px 0 ${highlight(0.85)},
      inset 0 2px 0 ${highlight(0.35)},
      0 2px 4px ${ink(0.05)},
      0 10px 24px ${ink(0.12)},
      0 22px 44px ${ink(0.1)}
    `,
    active: `
      inset 0 2px 3px ${ink(0.12)},
      inset 0 1px 0 ${highlight(0.35)},
      0 1px 2px ${ink(0.06)}
    `,
    selected: `
      inset 0 1px 0 ${highlight(0.2)},
      inset 0 2px 0 ${highlight(0.08)},
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
