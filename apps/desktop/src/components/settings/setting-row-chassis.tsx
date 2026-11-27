import { Box, Typography, type Theme } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import type { ReactNode } from "react";
import { premiumSurface } from "../../styles/shadows";

/**
 * The chassis every row on the settings surface is built from.
 *
 * These are typed as style *objects* rather than `SxProps`: an `SxProps`-typed
 * value is the whole union — a bare object, a callback, or an array of either —
 * and TypeScript cannot narrow a value imported from another module into the
 * array form `sx={[a, b]}` needs. Every consumer composes these into an array,
 * so the object form is the one contract that fits them all.
 *
 * A row is one shape: a label column that takes the remaining width and a
 * control column that holds whatever the row reports or offers. Keeping the
 * shape here rather than inside one row component is what lets an anchored
 * settings row and an unanchored summary row line up in the same card without
 * copying numbers.
 */

/** The border a settings card draws, in pixels. */
const settingsCardBorderWidth = 1;

/** The horizontal inset a row takes inside its card, in theme spacing units. */
const settingsRowInset = 2;

/** The distance from the card's outside edge to the row's content edge. */
export const settingsCardContentInset = (theme: Theme): string =>
  `calc(${theme.spacing(settingsRowInset)} + ${settingsCardBorderWidth}px)`;

/**
 * The width of a row's leading slot, in pixels.
 *
 * Fixed rather than sized to the glyph inside it. An icon is what says a row
 * opens or leaves, and only some rows have one. A row that sized its own slot
 * would start its label on a different column from the row above it, which is
 * exactly what the label column exists to prevent.
 */
export const settingsRowLeadingSlotWidth = 24;

export const rowSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  width: "100%",
  minHeight: 56,
  px: settingsRowInset,
  py: 1.25,
  m: 0,
  border: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  textDecoration: "none",
};

/**
 * The card a group of settings sits in, and the card a search result panel
 * draws.
 *
 * One declaration for both: a search result is a settings row under a heading,
 * and it used to be drawn by hand with a radius from the large-dialog step,
 * which made the same surface change its shape depending on how you reached
 * it. Sharing the card is what keeps the two from drifting apart again.
 */
export const settingsCardSx = (theme: Theme): SystemStyleObject<Theme> => ({
  border: `${settingsCardBorderWidth}px solid`,
  borderColor: "divider",
  borderRadius: 1,
  bgcolor: "level1",
  boxShadow: premiumSurface.light.rest,
  ...theme.applyStyles("dark", { boxShadow: premiumSurface.dark.rest }),
  overflow: "hidden",
  "& > * + *": {
    borderTop: `${settingsCardBorderWidth}px solid`,
    borderColor: "divider",
  },
});

export const interactiveSx: SystemStyleObject<Theme> = {
  cursor: "pointer",
  transition: "background-color 150ms ease",
  "&:hover": { backgroundColor: "action.hover" },
  "&:hover .setting-row-action": { backgroundColor: "action.selected" },
  "&:active": { backgroundColor: "action.selected" },
  "&:disabled": { cursor: "not-allowed", opacity: 0.5 },
  "&:focus-visible": {
    outline: "2px solid",
    outlineColor: "primary.main",
    outlineOffset: -2,
  },
};

/** Shared control column: one width, right aligned, for every row. */
export const controlColumnSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: 1,
  // Kept clear of the label column on top of the row's own gap. A control has
  // an outline of its own, and a segmented track that starts a word away from
  // the description beside it reads as one crowded block rather than as a
  // label and the thing it sets.
  pl: 1,
  flexShrink: 0,
  width: { xs: "auto", md: 240 },
  maxWidth: "60%",
};

/**
 * The control column for a row whose control is wider than the shared width.
 *
 * The fixed 240px above is right for a settings page, where values line up down
 * a long list, but it is a *column* width, not a budget for what a control may
 * draw: a segmented control holds as many options as the setting has, in
 * whatever language the person is reading, and one that does not fit is clipped
 * mid-word rather than wrapped. So a control sizes to its content, and the label
 * column — which can wrap — gives up the difference. Values and controls are
 * both right aligned, so the edge they share still lines up either way.
 */
export const contentControlColumnSx: SystemStyleObject<Theme> = {
  ...controlColumnSx,
  width: "auto",
  // The cap is the label's floor: a value that grows eats the label beside it,
  // and the ellipsis on the value says so. A control is not a value — it is as
  // wide as its options and no wider, because the text inside it cannot be
  // shortened — so there the cap only ever cuts a control in half, which is the
  // clipping this column exists to stop. The floor still matters where the row
  // has nothing to spare, which is why the cap stays on the narrowest sizes.
  maxWidth: { xs: "60%", sm: "none" },
};

/**
 * The control column for a row whose only trailing thing is the glyph that says
 * the row goes somewhere.
 *
 * The fixed column above is a *value* column: it is what keeps reported values
 * on one line down a page. A chevron is not a value, and holding the whole
 * column for one was taking the width away from the label. In the default
 * window a two-sentence description wrapped every six words while a third of
 * the row stayed empty beside it. Sizing the column to the glyph gives that
 * width back, and the glyph still lands on the card's content edge, because
 * the label column takes whatever is left.
 */
export const trailingGlyphColumnSx: SystemStyleObject<Theme> = {
  ...controlColumnSx,
  width: "auto",
  maxWidth: "none",
};

const labelColumnSx: SystemStyleObject<Theme> = {
  flexGrow: 1,
  minWidth: 0,
};

export const SettingRowText = ({
  subtitle,
  title,
  description,
  titleId,
  descriptionId,
  rootComponent = "span",
  titleHeadingLevel,
}: {
  /**
   * What the row's subject is, above it: "AI transcription" over the model that
   * answers it.
   *
   * A summary of a setting on another page has to say both which thing it is
   * about and which one is chosen, and the thing it is about is not the row's
   * value — it is the shape of the answer. The word goes above in small muted
   * type so the eye lands on the answer first and reads the label only when it
   * needs to, which is the opposite of what a row's title would do with it.
   */
  subtitle?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /**
   * Ids exist so a row that owns a control can point the control at its own
   * label. A row that is itself the control is named by its contents, so it
   * passes neither.
   */
  titleId?: string;
  descriptionId?: string;
  /**
   * `div` for a row that is already a block, `span` for a row that is a
   * button, where only phrasing content is valid.
   */
  rootComponent?: "span" | "div";
  /**
   * Renders the title as a native heading element. Used where the settings
   * document outline needs this row named, rather than a `role="heading"` span.
   */
  titleHeadingLevel?: 2 | 3 | 4 | 5 | 6;
}) => (
  <Box
    component={rootComponent}
    className="setting-row-label"
    sx={{ ...labelColumnSx, display: "block" }}
  >
    {subtitle && (
      <Typography
        variant="caption"
        component="span"
        sx={{ display: "block", color: "text.secondary" }}
      >
        {subtitle}
      </Typography>
    )}
    <Typography
      id={titleId}
      component={titleHeadingLevel ? `h${titleHeadingLevel}` : "span"}
      variant="body1"
      sx={{ display: "block", fontWeight: 600 }}
    >
      {title}
    </Typography>
    {description && (
      <Typography
        id={descriptionId}
        component="span"
        variant="body2"
        sx={{
          display: "block",
          color: "text.secondary",
          mt: 0.25,
          // The same measure the page and group descriptions take, so a long
          // explanation wraps at a readable line instead of running the width
          // of a wide card.
          maxWidth: "72ch",
        }}
      >
        {description}
      </Typography>
    )}
  </Box>
);

/**
 * The tile a summary row's leading glyph sits in.
 *
 * Shared rather than declared per row kind: a settings summary draws a label
 * with an icon beside it, and the models card draws two stacked lines beside
 * the same tile — the tile is one object either way, and duplicating it is how
 * two surfaces that are meant to look identical drift apart.
 */
const summaryIconTileSize = 40;

export const summaryIconTileSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: summaryIconTileSize,
  height: summaryIconTileSize,
  border: 1,
  borderColor: "divider",
  borderRadius: 1,
  bgcolor: "level2",
  color: "text.secondary",
};

/**
 * The tile of a row whose subject needs the person's attention: a provider with
 * no key, a model that is not downloaded. The row's own text carries the state;
 * the tint only agrees with it.
 */
export const attentionTileSx: SystemStyleObject<Theme> = {
  color: "warning.main",
  borderColor: (theme: Theme) =>
    `rgb(${theme.vars?.palette?.warning.mainChannel} / 0.4)`,
};

/**
 * A trailing glyph, tinted by the row rather than by the icon library.
 *
 * lucide draws in `currentColor`, so the colour rides the wrapper and matches
 * the app's one icon family (stroke 1.9) instead of an icon component's own
 * colour prop.
 */
export const TrailingGlyph = ({ children }: { children: ReactNode }) => (
  <Box
    component="span"
    sx={{ display: "flex", alignItems: "center", color: "text.secondary" }}
  >
    {children}
  </Box>
);

/**
 * A row's reported value: one line, ellipsised, right aligned before whatever
 * follows it.
 *
 * The row that owns a setting and the summary row that reports one from another
 * page carried identical copies of this — same variant, same three truncation
 * properties — so a change to how a value reads had to be made twice or it
 * landed in one surface only.
 */
export const SettingRowValue = ({ value }: { value?: ReactNode }) =>
  value == null ? null : (
    <Typography
      variant="body2"
      sx={{
        color: "text.secondary",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {value}
    </Typography>
  );
