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
 * The control column of a summary row, which sizes to its content.
 *
 * The shared column's fixed 240px is right for a settings page, where values
 * line up down a long list. In a two-up quick-access card it would push the
 * label column past its own width, so this keeps the alignment rules and the
 * gap and lets the column be as wide as what it holds.
 */
export const summaryControlColumnSx: SystemStyleObject<Theme> = {
  ...controlColumnSx,
  width: "auto",
};

export const labelColumnSx: SystemStyleObject<Theme> = {
  flexGrow: 1,
  minWidth: 0,
};

export const SettingRowText = ({
  title,
  description,
  titleId,
  descriptionId,
}: {
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
