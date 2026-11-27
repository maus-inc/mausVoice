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
import { Children, type ChangeEvent, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import type { SystemStyleObject } from "@mui/system";
import { openExternalUrl } from "../../utils/open-url.utils";
import { settingAnchorId } from "./settings-routes";
import {
  contentControlColumnSx,
  controlColumnSx,
  interactiveSx,
  rowSx,
  settingsCardContentInset,
  settingsCardSx,
  settingsRowLeadingSlotWidth,
  SettingRowText,
  SettingRowValue,
  trailingGlyphColumnSx,
  TrailingGlyph,
} from "./setting-row-chassis";
import { useSettingHighlight } from "./settings-highlight";

/**
 * The leading slot every row opens with, icon or no icon.
 *
 * The icon says a row opens or leaves, so only some rows carry one; the slot is
 * the same width either way, which is what puts every label in a card on one
 * column. Reserved inside the row rather than reported by the group, because a
 * group is a list of rows and no row should have to know what its neighbours
 * look like to be laid out.
 *
 * A `span`, not a `div`: the slot is a child of a row that is sometimes a
 * button, and a button may only contain phrasing content.
 */
const leadingSlotSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: settingsRowLeadingSlotWidth,
  color: "text.secondary",
};

const highlightSx: SxProps<Theme> = {
  outline: "2px solid",
  outlineColor: "primary.main",
  // Keep the temporary search marker inside the group's clipped corners.
  outlineOffset: -4,
  borderRadius: 1,
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
/**
 * The glyph that ends the column, when the row ends with one.
 *
 * Outward for a URL, a chevron for something that opens in place, and nothing
 * when the row already spells out its verb in the action pill.
 */
const TrailingArrow = ({
  externalUrl,
  interactive,
  action,
}: {
  externalUrl?: string;
  interactive: boolean;
  action?: SettingRowAction;
}) => {
  if (externalUrl) {
    return (
      <TrailingGlyph>
        <ArrowUpRight size={18} strokeWidth={1.9} />
      </TrailingGlyph>
    );
  }
  if (!interactive || action) {
    return null;
  }
  return (
    <TrailingGlyph>
      <ChevronRight size={20} strokeWidth={1.9} />
    </TrailingGlyph>
  );
};

/** The named action at the end of a row: a pill, not a control. */
const ActionPill = ({ action }: { action: SettingRowAction }) => {
  const theme = useTheme();
  return (
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
  );
};

/**
 * How wide the column may be.
 *
 * A row that holds a control gives it the width it needs; a row that reports a
 * value keeps the fixed column, so values still line up down a page; a row that
 * only points somewhere keeps nothing but its glyph. The three cases are one
 * decision, so it is made here rather than by each row.
 */
const columnFor = ({
  control,
  value,
  action,
}: {
  control?: ReactNode;
  value?: ReactNode;
  action?: SettingRowAction;
}): SystemStyleObject<Theme> => {
  if (control) return contentControlColumnSx;
  if (value || action) return controlColumnSx;
  return trailingGlyphColumnSx;
};

const SettingRowControlColumn = ({
  value,
  control,
  action,
  externalUrl,
  interactive,
}: SettingRowControlColumnProps) => (
  <Box
    sx={[
      columnFor({ control, value, action }),
      // A long reported value beside a named action must not consume the space
      // the row's label and description need at compact widths.
      ...(value && action ? [{ maxWidth: { xs: "45%", md: "60%" } }] : []),
    ]}
  >
    <SettingRowValue value={value} />
    {control}
    {action && <ActionPill action={action} />}
    <TrailingArrow
      externalUrl={externalUrl}
      interactive={interactive}
      action={action}
    />
  </Box>
);

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
  /** Renders the title as a native heading for the document outline. */
  titleHeadingLevel?: 2 | 3 | 4 | 5 | 6;
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
  titleHeadingLevel,
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
      <Box component="span" aria-hidden sx={leadingSlotSx}>
        {icon}
      </Box>
      <SettingRowText
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
        rootComponent={interactive ? "span" : "div"}
        titleHeadingLevel={titleHeadingLevel}
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
      <InteractiveSettingRow
        anchorId={anchorId}
        disabled={disabled}
        highlight={highlight}
        onClick={handleClick}
      >
        {body}
      </InteractiveSettingRow>
    );
  }

  return (
    <StaticSettingRow
      anchorId={anchorId}
      highlight={highlight}
      wrapsWideControl={Boolean(control && !icon)}
    >
      {body}
    </StaticSettingRow>
  );
};

type SettingRowShellProps = {
  anchorId: string;
  highlight: boolean;
  children: ReactNode;
};

const InteractiveSettingRow = ({
  anchorId,
  disabled,
  highlight,
  onClick,
  children,
}: SettingRowShellProps & {
  disabled: boolean | undefined;
  onClick: () => void;
}) => (
  <Box
    id={anchorId}
    component="button"
    type="button"
    onClick={onClick}
    disabled={disabled}
    sx={[rowSx, interactiveSx, ...(highlight ? [highlightSx] : [])]}
  >
    {children}
  </Box>
);

const StaticSettingRow = ({
  anchorId,
  highlight,
  wrapsWideControl,
  children,
}: SettingRowShellProps & { wrapsWideControl: boolean }) => (
  <Box
    id={anchorId}
    sx={[
      rowSx,
      // Wide controls must not squeeze their explanation into a narrow column.
      // Let them move below it when the card runs out of room.
      ...(wrapsWideControl
        ? [
            {
              flexWrap: "wrap" as const,
              // By class, not by position: the row opens with its leading slot,
              // which occupies the place a `:first-of-type` selector used to
              // read as the label.
              "& > .setting-row-label": { flexBasis: "min(200px, 100%)" },
              "& > :last-child": { maxWidth: "100%", ml: "auto" },
            },
          ]
        : []),
      ...(highlight ? [highlightSx] : []),
    ]}
  >
    {children}
  </Box>
);

export type SettingToggleRowProps = {
  settingKey: string;
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void | Promise<unknown>;
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
      <Box component="span" aria-hidden sx={leadingSlotSx} />
      <SettingRowText
        title={title}
        description={description}
        titleId={titleId}
        descriptionId={descriptionId}
      />
      <Box sx={contentControlColumnSx}>
        <Switch
          checked={checked}
          onChange={(event) => {
            void Promise.resolve(onChange(event)).catch(() => {});
          }}
          disabled={disabled}
          edge="end"
          slotProps={{
            input: {
              // Announce as a switch, not a checkbox: these rows toggle a
              // setting that applies immediately (APG switch pattern).
              role: "switch",
              "aria-labelledby": titleId,
              ...(descriptionId
                ? { "aria-describedby": descriptionId }
                : undefined),
            },
            // Reduced motion suppresses the thumb/track travel, never the
            // state change itself: the checked color and thumb position still
            // land, just without decorative animation (WCAG 2.3.3 / animation
            // from interactions). Documented slots, not generated selectors.
            switchBase: {
              sx: {
                "@media (prefers-reduced-motion: reduce)": {
                  transition: "none",
                },
              },
            },
            thumb: {
              sx: {
                "@media (prefers-reduced-motion: reduce)": {
                  transition: "none",
                },
              },
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
  mb: hasDescription ? 0.75 : 1.5,
});

/** The heading's line: the title names the card; its action belongs to its content. */
const groupHeadingRowSx: SystemStyleObject<Theme> = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 2,
};

/** The action is a control, so its edge follows the rows' content edge. */
const groupActionSx: SxProps<Theme> = (theme) => ({
  marginRight: settingsCardContentInset(theme),
});

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
 *
 * A group with nothing to show draws nothing. Every group is a list of rows
 * behind their own availability, and when they are all unavailable the card
 * still drew its heading and a two-pixel empty enclosure under it, which reads
 * as a stray rule at the foot of the page.
 */
export const SettingGroup = ({
  title,
  description,
  danger,
  action,
  children,
}: SettingGroupProps) => {
  if (Children.toArray(children).length === 0) {
    return null;
  }

  return (
    <Box component="section" sx={{ mb: 4 }}>
      <Box sx={groupHeadingRowSx}>
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
        {action && <Box sx={groupActionSx}>{action}</Box>}
      </Box>
      {description && (
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", mb: 1.5, maxWidth: "72ch" }}
        >
          {description}
        </Typography>
      )}
      <Box sx={[settingsCardSx, ...(danger ? [dangerCardSx] : [])]}>
        {children}
      </Box>
    </Box>
  );
};

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
