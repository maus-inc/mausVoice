import type { Theme } from "@mui/material";
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

/**
 * Theme-aware selected outline for cards/rows that signal selection with a
 * stroke (API-key cards, model download rows).
 *
 * The stroke is the scheme's own text token — dark ink on cream in light mode,
 * light text on onyx in dark mode — so the ring is unmistakable in both
 * schemes. Two subtleties make the `theme.vars` read necessary:
 *
 * - `theme.vars` emits the palette as a CSS variable (`var(--app-palette-…)`)
 *   that resolves per active color scheme at runtime; a raw `theme.palette`
 *   read would freeze in the light value and vanish against dark surfaces —
 *   the original dark-mode bug.
 * - MUI emits a `[data-mui-color-scheme="dark"]` override for outlined Paper
 *   that resets the `border` shorthand after sx, so the border alone cannot
 *   carry the selection signal in dark mode. The ring lives in box-shadow,
 *   which no override touches, and keeps the outline crisp on top of the
 *   card's own border in both schemes.
 *
 * Hover is intentionally left to the consumer (ApiKeyCard owns it in a single
 * place), so this stays a pure selected-state declaration; the global
 * `:focus-visible` outline in the theme still handles keyboard focus.
 *
 * @param ringWidth thickness of the outline ring in px (default 1).
 */
export const selectedOutlineSx = (theme: Theme, ringWidth = 1) => ({
  borderColor: "text.primary",
  boxShadow: `0 0 0 ${ringWidth}px ${theme.vars.palette.text.primary}`,
});

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
