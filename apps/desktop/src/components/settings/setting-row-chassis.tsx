import { Box, Typography, type Theme } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import type { ReactNode } from "react";

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

export const rowSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  width: "100%",
  minHeight: 56,
  px: 2,
  py: 1.25,
  m: 0,
  border: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  textDecoration: "none",
};

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
};

export const labelColumnSx: SystemStyleObject<Theme> = {
  flexGrow: 1,
  minWidth: 0,
};

export const SettingRowText = ({
  subtitle,
  title,
  description,
  titleId,
  descriptionId,
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
}) => (
  <Box sx={labelColumnSx}>
    {subtitle && (
      <Typography
        variant="caption"
        component="span"
        sx={{ display: "block", color: "text.secondary" }}
      >
        {subtitle}
      </Typography>
    )}
    <Typography id={titleId} variant="body1" sx={{ fontWeight: 600 }}>
      {title}
    </Typography>
    {description && (
      <Typography
        id={descriptionId}
        variant="body2"
        sx={{ color: "text.secondary", mt: 0.25 }}
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
export const summaryIconTileSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 40,
  height: 40,
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
