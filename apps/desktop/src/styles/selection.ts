import { duration, easeOutCubic } from "./motion";

/**
 * Shared active-row treatment for the AI menus (transcription + post-processing).
 *
 * MUI's default `.Mui-selected` wash is a few percent of `action.selected`,
 * which is impossible to find at a glance in a long, scrolling model list. The
 * active row instead gets an accent rail plus a tinted fill derived from the
 * single accent blue, so the selection reads immediately and identically in
 * both menus.
 */

/** Width of the accent rail that marks the active row. */
const RAIL_WIDTH = 3;

const ease = `cubic-bezier(${easeOutCubic.join(", ")})`;
const transition = `${duration.fast}s ${ease}`;

/** The accent at partial strength, resolved per scheme via the CSS variable. */
const accentFill = (percent: number) =>
  `color-mix(in srgb, var(--app-palette-blue) ${percent}%, transparent)`;

/**
 * Applies to the row itself. Mark the active row with either `data-active`
 * (plain rows) or MUI's `.Mui-selected` (menu items) — both selectors are
 * handled here so the two menus cannot drift apart.
 *
 * The rail is always present and merely changes colour, so selecting a row
 * never shifts its contents. Timing is a subtle tint fade; the global
 * reduced-motion reset in the theme neutralises it.
 */
export const activeRowSx = {
  borderLeft: `${RAIL_WIDTH}px solid transparent`,
  transition: `background-color ${transition}, border-color ${transition}`,
  "&:hover": {
    backgroundColor: "action.hover",
  },
  "&[data-active='true'], &.Mui-selected": {
    borderLeftColor: "var(--app-palette-blue)",
    backgroundColor: accentFill(12),
    "&:hover": {
      backgroundColor: accentFill(18),
    },
  },
};

/** The check glyph that accompanies the rail on the active row. */
export const activeRowCheckSx = {
  color: "var(--app-palette-blue)",
  flexShrink: 0,
};
