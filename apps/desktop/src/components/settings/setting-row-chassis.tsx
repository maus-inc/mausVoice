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
  // The cap is the label's floor: a value that grows eats the label beside it,
  // and the ellipsis on the value says so. A control is not a value — it is as
  // wide as its options and no wider, because the text inside it cannot be
  // shortened — so there the cap only ever cuts a control in half, which is the
  // clipping this column exists to stop. The floor still matters where the row
  // has nothing to spare, which is why the cap stays on the narrowest sizes.
  maxWidth: { xs: "60%", sm: "none" },
};

/**
 * The size and stroke every settings glyph is drawn at.
 *
 * Spread it into the lucide icon rather than typing a size per row: a card holds
 * icons from several groups, and one row at 20px beside one at 24px reads as two
 * icon sets. Third-party provider marks are the exception, since a mark is
 * fitted into its own square and carries no stroke.
 */
export const settingGlyphProps = { size: 22, strokeWidth: 1.9 } as const;

/**
 * The one lane a row's leading glyph sits in.
 *
 * A glyph names the kind of thing a row controls, so it is part of the row's
 * shape rather than decoration on it. The lane is the shared glyph size wide,
 * not the width of whatever was passed in, so a provider mark, a lucide glyph
 * and an avatar cannot each start their row's title somewhere different.
 * `minWidth` rather than `width` is deliberate, because the identity row leads
 * with a larger avatar and clipping that to a glyph's box would cut it.
 */
const leadingGlyphSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  minWidth: settingGlyphProps.size,
  minHeight: settingGlyphProps.size,
  color: "text.secondary",
};

/** A destructive row's glyph, in the palette's destructive colour. */
const dangerGlyphSx: SystemStyleObject<Theme> = { color: "error.main" };

/** The label block: the glyph lane, then the row's own text column. */
const settingRowLabelSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 2,
  flexGrow: 1,
  minWidth: 0,
};

export type SettingIconTone = "secondary" | "danger";

/**
 * The label half of a row: the glyph lane, then the title and description.
 *
 * It is one element so that the wrap a wide control needs moves the whole label
 * as a block. Left as siblings, the glyph would stay behind on the control's
 * line while its own text moved below, which is the alignment the icon lane
 * exists to prevent. The `component` follows the host row's content model:
 * phrasing inside the label and button rows, a block inside a static row.
 */
export const SettingRowLabel = ({
  icon,
  iconTone = "secondary",
  rootComponent = "span",
  children,
}: {
  icon?: ReactNode;
  iconTone?: SettingIconTone;
  rootComponent?: "span" | "div";
  children: ReactNode;
}) => (
  <Box
    component={rootComponent}
    className="setting-row-label"
    sx={settingRowLabelSx}
  >
    {icon && (
      <Box
        component="span"
        aria-hidden
        sx={[leadingGlyphSx, ...(iconTone === "danger" ? [dangerGlyphSx] : [])]}
      >
        {icon}
      </Box>
    )}
    {children}
  </Box>
);

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
  <Box component={rootComponent} sx={{ ...labelColumnSx, display: "block" }}>
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
        sx={{ display: "block", color: "text.secondary", mt: 0.25 }}
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
