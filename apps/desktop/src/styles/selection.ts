import { duration, easeOutCubic } from "./motion";

/**
 * Shared active-row treatment for the AI menus (transcription + post-processing).
 *
 * MUI's default `.Mui-selected` wash is a few percent of `action.selected`,
 * which is impossible to find at a glance in a long, scrolling model list. The
 * active row instead gets an always-present rail that only changes colour, a
 * neutral tinted fill, and a check glyph. It is intentionally neutral (no
 * accent) so it reads as "selected" without reintroducing the blue the app
 * moved away from.
 */

/** Width of the rail that marks the active row. */
const RAIL_WIDTH = 3;

const ease = `cubic-bezier(${easeOutCubic.join(", ")})`;
const transition = `${duration.fast}s ${ease}`;

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
    // Neutral onyx rail + a low-contrast neutral fill (no accent colour).
    borderLeftColor: "text.primary",
    backgroundColor: "action.selected",
    "&:hover": {
      backgroundColor: "action.selected",
    },
  },
};

/** The check glyph that accompanies the rail on the active row. */
export const activeRowCheckSx = {
  color: "text.primary",
  flexShrink: 0,
};
