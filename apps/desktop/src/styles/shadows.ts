/**
 * Sigma-style layered surfaces:
 * - 2px inner highlight from the top (emboss)
 * - soft multi-stop drop shadow below (premium lift)
 */
export const premiumSurface = {
  light: {
    rest: `
      inset 0 1px 0 rgba(255,255,255,0.72),
      inset 0 2px 0 rgba(255,255,255,0.28),
      0 1px 2px rgba(15,18,25,0.04),
      0 6px 16px rgba(15,18,25,0.08),
      0 14px 32px rgba(15,18,25,0.06)
    `,
    hover: `
      inset 0 1px 0 rgba(255,255,255,0.85),
      inset 0 2px 0 rgba(255,255,255,0.35),
      0 2px 4px rgba(15,18,25,0.05),
      0 10px 24px rgba(15,18,25,0.12),
      0 22px 44px rgba(15,18,25,0.1)
    `,
    active: `
      inset 0 2px 3px rgba(15,18,25,0.12),
      inset 0 1px 0 rgba(255,255,255,0.35),
      0 1px 2px rgba(15,18,25,0.06)
    `,
    selected: `
      inset 0 1px 0 rgba(255,255,255,0.2),
      inset 0 2px 0 rgba(255,255,255,0.08),
      0 1px 2px rgba(15,18,25,0.18),
      0 8px 20px rgba(15,18,25,0.22)
    `,
  },
  dark: {
    rest: `
      inset 0 1px 0 rgba(255,255,255,0.08),
      inset 0 2px 0 rgba(255,255,255,0.03),
      0 1px 2px rgba(0,0,0,0.35),
      0 8px 20px rgba(0,0,0,0.35),
      0 18px 40px rgba(0,0,0,0.28)
    `,
    hover: `
      inset 0 1px 0 rgba(255,255,255,0.12),
      inset 0 2px 0 rgba(255,255,255,0.05),
      0 2px 4px rgba(0,0,0,0.4),
      0 12px 28px rgba(0,0,0,0.42),
      0 28px 56px rgba(0,0,0,0.35)
    `,
    active: `
      inset 0 2px 4px rgba(0,0,0,0.45),
      inset 0 1px 0 rgba(255,255,255,0.04),
      0 1px 2px rgba(0,0,0,0.35)
    `,
    selected: `
      inset 0 1px 0 rgba(255,255,255,0.14),
      inset 0 2px 0 rgba(255,255,255,0.05),
      0 1px 2px rgba(0,0,0,0.4),
      0 10px 24px rgba(0,0,0,0.45)
    `,
  },
} as const;

export const titleBarShadow = {
  light: `0 1px 0 rgba(255,255,255,0.7), 0 8px 24px rgba(15,18,25,0.06)`,
  dark: `inset 0 -1px 0 rgba(255,255,255,0.04), 0 10px 28px rgba(0,0,0,0.35)`,
} as const;
