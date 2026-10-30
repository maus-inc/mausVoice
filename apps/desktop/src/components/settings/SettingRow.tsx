import { ArrowUpRight, ChevronRight } from "lucide-react";
import {
  Box,
  Link as MuiLink,
  Switch,
  Typography,
  useTheme,
  type SxProps,
  type Theme,
} from "@mui/material";
import type { ChangeEvent, ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { openExternalUrl } from "../../utils/open-url.utils";
import { settingAnchorId } from "./settings-routes";
import {
  contentControlColumnSx,
  controlColumnSx,
  interactiveSx,
  rowSx,
  SettingRowText,
  SettingRowValue,
  TrailingGlyph,
} from "./setting-row-chassis";
import { useSettingHighlight } from "./settings-highlight";

const highlightSx: SxProps<Theme> = {
  outline: "2px solid",
  outlineColor: "primary.main",
  outlineOffset: -2,
};

/** Read a theme length that may be a number or a CSS length. */
const cssPixels = (value: number | string): number =>
  typeof value === "number" ? value : Number.parseFloat(value);

/**
 * A row's trailing affordance, drawn as a small outlined pill.
 *
 * A chevron says "something happens here"; it cannot say what. Rows whose
 * meaning is a verb (edit this, clear that) name it instead, and the pill
 * matches the shape the rest of the app's buttons use. It is a span rather than
 * a button because the row itself is already the button, and a button inside a
 * button is neither valid markup nor reachable by keyboard.
 */
const actionPillSx = (
  tone: "primary" | "error",
  // Two pixels inside the app's button radius, from the same token, so the pill
  // and the buttons it sits beside cannot drift apart. A CSS length string, not
  // a number: `sx` multiplies a numeric radius by `shape.borderRadius`, so the
  // pixel value this computes has to be spelled out to survive as pixels.
  radius: string,
): SxProps<Theme> => ({
  display: "inline-flex",
  alignItems: "center",
  height: 30,
  px: 1.5,
  borderRadius: radius,
  border: "1px solid",
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
  flexShrink: 0,
  ...(tone === "error"
    ? {
        color: "error.main",
        borderColor: (theme: Theme) =>
          `rgb(${theme.vars?.palette?.error.mainChannel} / 0.4)`,
      }
    : {
        color: "text.primary",
        borderColor: "divider",
        bgcolor: "level2",
      }),
});

type SettingRowAction = { label: ReactNode; tone?: "primary" | "error" };

type SettingRowControlColumnProps = {
  value?: ReactNode;
  control?: ReactNode;
  action?: SettingRowAction;
  externalUrl?: string;
  interactive: boolean;
};

/**
 * The right-hand column: the reported value, the control, the action pill and
 * the trailing affordance, in that order.
 *
 * It is one component rather than markup inside `SettingRow` because two rows
 * that differ in what they hold still have to line up, and the arrow is the
 * only part that depends on what the row does: outward for a URL, a chevron for
 * something that opens in place, and nothing when the row already spells out
 * its verb in the action pill.
 */
const SettingRowControlColumn = ({
  value,
  control,
  action,
  externalUrl,
  interactive,
}: SettingRowControlColumnProps) => {
  const theme = useTheme();

  let trailingIcon: ReactNode = null;
  if (externalUrl) {
    trailingIcon = (
      <TrailingGlyph>
        <ArrowUpRight size={18} strokeWidth={1.9} />
      </TrailingGlyph>
    );
  } else if (interactive && !action) {
    trailingIcon = (
      <TrailingGlyph>
        <ChevronRight size={20} strokeWidth={1.9} />
      </TrailingGlyph>
    );
  }

  // A row that holds a control gives it the width it needs; a row that only
  // reports a value keeps the fixed column, so values still line up down a
  // page. See `contentControlColumnSx` for why the two are not one width.
  return (
    <Box sx={control ? contentControlColumnSx : controlColumnSx}>
      <SettingRowValue value={value} />
      {control}
      {action && (
        <Box
          component="span"
          className="setting-row-action"
          sx={actionPillSx(
            action.tone ?? "primary",
            `${cssPixels(theme.shape.borderRadius) - 2}px`,
          )}
        >
          {action.label}
        </Box>
      )}
      {trailingIcon}
    </Box>
  );
};

export type SettingRowProps = {
  /** Registry key: the row's anchor id and search identity. */
  settingKey: string;
  title: ReactNode;
  description?: ReactNode;
  /** Leading icon. Reserved for rows that open or leave, so it signals action. */
  icon?: ReactNode;
  /** Trailing control, right aligned in the shared control column. */
  control?: ReactNode;
  /** Reported value, for rows that only state something. */
  value?: ReactNode;
  /**
   * Names the row's action instead of showing a chevron. Use it wherever the
   * verb is obvious enough to spell out.
   */
  action?: { label: ReactNode; tone?: "primary" | "error" };
  /** Makes the whole row one button that opens a dialog or starts a task. */
  onClick?: () => void;
  /** Makes the row one button that opens this URL in the browser. */
  externalUrl?: string;
  disabled?: boolean;
};

/**
 * A row that states a value or holds a control, and optionally acts as a
 * button. Rows that toggle a switch use `SettingToggleRow` instead, because a
 * switch needs the row itself to be its label.
 */
export const SettingRow = ({
  settingKey,
  title,
  description,
  icon,
  control,
  value,
  action,
  onClick,
  externalUrl,
  disabled,
}: SettingRowProps) => {
  const highlight = useSettingHighlight(settingKey);
  const anchorId = settingAnchorId(settingKey);
  const titleId = `${anchorId}-label`;
  const descriptionId = description ? `${anchorId}-description` : undefined;
  const interactive = Boolean(onClick || externalUrl);

  const handleClick = () => {
    if (disabled) {
      return;
    }
    if (externalUrl) {
      openExternalUrl(externalUrl, "the link for this setting");
      return;
    }
    onClick?.();
  };

  const body = (
    <>
      {icon && (
        <Box
          aria-hidden
          sx={{
            display: "flex",
            alignItems: "center",
            color: "text.secondary",
            flexShrink: 0,
          }}
        >
          {icon}
        </Box>
      )}
      <SettingRowText
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
      />
      <SettingRowControlColumn
        value={value}
        control={control}
        action={action}
        externalUrl={externalUrl}
        interactive={interactive}
      />
    </>
  );

  if (interactive) {
    return (
      <Box
        id={anchorId}
        component="button"
        type="button"
        onClick={handleClick}
        disabled={disabled}
        sx={[rowSx, interactiveSx, ...(highlight ? [highlightSx] : [])]}
      >
        {body}
      </Box>
    );
  }

  return (
    <Box
      id={anchorId}
      sx={[
        rowSx,
        // Wide controls must not squeeze their explanation into a narrow
        // column. Let them move below it when the card runs out of room.
        ...(control && !icon
          ? [
              {
                flexWrap: "wrap" as const,
                "& > :first-of-type": { flexBasis: "min(200px, 100%)" },
                "& > :last-child": { maxWidth: "100%", ml: "auto" },
              },
            ]
          : []),
        ...(highlight ? [highlightSx] : []),
      ]}
    >
      {body}
    </Box>
  );
};

export type SettingToggleRowProps = {
  settingKey: string;
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
};

/**
 * A row that toggles a switch.
 *
 * The row is a `<label>` wrapping the switch, so clicking anywhere on it
 * toggles, which is what the shape promises. The switch takes its accessible
 * name from the row title and its description from the row description, rather
 * than rendering as an unnamed control beside a paragraph, which is what it
 * did before.
 */
export const SettingToggleRow = ({
  settingKey,
  title,
  description,
  checked,
  onChange,
  disabled,
}: SettingToggleRowProps) => {
  const highlight = useSettingHighlight(settingKey);
  const anchorId = settingAnchorId(settingKey);
  const titleId = `${anchorId}-label`;
  const descriptionId = description ? `${anchorId}-description` : undefined;

  return (
    <Box
      id={anchorId}
      component="label"
      sx={[
        rowSx,
        {
          cursor: disabled ? "not-allowed" : "pointer",
          "&:hover": { backgroundColor: "action.hover" },
        },
        ...(highlight ? [highlightSx] : []),
      ]}
    >
      <SettingRowText
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
      />
      <Box sx={controlColumnSx}>
        <Switch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          edge="end"
          slotProps={{
            input: {
              "aria-labelledby": titleId,
              ...(descriptionId
                ? { "aria-describedby": descriptionId }
                : undefined),
            },
          }}
        />
      </Box>
    </Box>
  );
};

export type SettingGroupProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Marks the group as destructive: the heading takes the error colour. */
  danger?: boolean;
  /**
   * A link out of the group, set on the heading's line.
   *
   * The card answers at a glance and the page behind it holds the rest, so the
   * way out belongs on the heading rather than as one more row at the bottom —
   * where it reads as another thing to check instead of a way to go deeper.
   */
  action?: ReactNode;
  children: ReactNode;
};

/**
 * The heading of a group.
 *
 * A destructive group gets the quieter label treatment: same words, different
 * weight, so the signal costs the page no extra space. The margin shrinks when
 * a description follows, because the description supplies the gap.
 */
const groupHeadingSx = (
  danger: boolean,
  hasDescription: boolean,
): SxProps<Theme> => ({
  display: "block",
  fontWeight: 700,
  color: danger ? "error.main" : "text.primary",
  ...(danger ? { letterSpacing: "0.06em", textTransform: "uppercase" } : {}),
  mb: hasDescription ? 0.5 : 1.5,
});

/**
 * The card every group's rows sit in.
 *
 * Radius 1 is the app's card step (14). The 28 step belongs to large dialogs,
 * and a settings card sitting at a dialog's radius read softer than the world
 * it lives in.
 */
const groupCardSx: SxProps<Theme> = {
  border: 1,
  borderRadius: 1,
  bgcolor: "level1",
  overflow: "hidden",
  "& > * + *": { borderTop: 1, borderColor: "divider" },
};

/**
 * The card treatment for a dangerous group: the error colour at a low alpha,
 * taken from the theme channel so it follows the palette in both schemes rather
 * than naming a red.
 */
const dangerCardSx: SxProps<Theme> = {
  borderColor: (theme: Theme) =>
    `rgb(${theme.vars?.palette?.error.mainChannel} / 0.35)`,
  bgcolor: (theme: Theme) =>
    `rgb(${theme.vars?.palette?.error.mainChannel} / 0.04)`,
};

/**
 * A titled card of rows. The card supplies the enclosure and the shared
 * control column does the alignment, so groups read as groups without relying
 * on whitespace alone.
 */
export const SettingGroup = ({
  title,
  description,
  danger,
  action,
  children,
}: SettingGroupProps) => (
  <Box component="section" sx={{ mb: 4 }}>
    <Box
      sx={{
        display: "flex",
        alignItems: "baseline",
        // The link sits on the heading's line and takes the leftover width only
        // when the heading is long, which is what keeps the two ends of a
        // two-up card from having their headings wrap differently.
        justifyContent: action ? "space-between" : "flex-start",
        gap: 2,
      }}
    >
      <Typography
        // A destructive group is presented as a label rather than as an equal
        // of the section headings above it. Same words, different weight: the
        // difference is the signal, and it costs the page no extra space.
        variant={danger ? "caption" : "h6"}
        component="h2"
        sx={groupHeadingSx(Boolean(danger), Boolean(description))}
      >
        {title}
      </Typography>
      {action}
    </Box>
    {description && (
      <Typography
        variant="body2"
        sx={{ color: "text.secondary", mb: 1.5, maxWidth: "72ch" }}
      >
        {description}
      </Typography>
    )}
    <Box sx={[groupCardSx, danger ? dangerCardSx : { borderColor: "divider" }]}>
      {children}
    </Box>
  </Box>
);

/**
 * The link on a group's heading line, for the page that owns the whole group.
 *
 * A card on the overview is a set of rows summarized; the page behind it is
 * where the rest lives, and that "rest" is the one thing a card cannot show. It
 * sits on the heading rather than as a row at the bottom because the rows of a
 * card are all settings, and a row that opens a page would be the one row that
 * is not — the two kinds of thing read as the same thing when they share the
 * same chassis.
 */
export const SettingGroupLink = ({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) => (
  <MuiLink
    component={RouterLink}
    to={to}
    variant="body2"
    underline="hover"
    sx={{
      color: "text.secondary",
      fontWeight: 600,
      whiteSpace: "nowrap",
      "&:hover": { color: "text.primary" },
    }}
  >
    {children}
  </MuiLink>
);
