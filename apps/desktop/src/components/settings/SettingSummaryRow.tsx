import { ChevronRight, Info } from "lucide-react";
import { Box, Tooltip, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { settingEntryOf } from "../../utils/settings-registry";
import { settingAnchorId, settingsPagePath } from "./settings-routes";
import {
  attentionTileSx,
  contentControlColumnSx,
  interactiveSx,
  rowSx,
  summaryIconTileSx,
  SettingRowText,
  TrailingGlyph,
} from "./setting-row-chassis";

/**
 * Where a summary row goes: to the setting it reports, or to the page that
 * holds it.
 *
 * `linksTo` is deliberately not called `settingKey`: an anchor is a row's own
 * identity, and these rows own no setting — the page that does keeps the
 * anchor, the search entry and the deep link. The distinction is also why a
 * quick-access page cannot accidentally register a second anchor for a row that
 * already has one.
 */
type SettingSummaryTarget =
  | {
      /** Registry key of the setting this summary reports. */
      linksTo: string;
      path?: never;
    }
  | {
      /** A page path, for a row that opens a whole page rather than a setting. */
      path: string;
      linksTo?: never;
    };

export type SettingSummaryRowProps = SettingSummaryTarget & {
  /** What the row is about, above its answer: see `SettingRowText`. */
  subtitle?: ReactNode;
  title: ReactNode;
  /**
   * What the row means, on hover.
   *
   * The row states what a key does in as few words as a label allows, and a
   * label cannot carry a sentence. Rather than hanging a second line under every
   * row — six of them turn a card into a page — the explanation waits behind an
   * info glyph for the one person who wants it.
   */
  tooltip?: ReactNode;
  /** Leading glyph, drawn in a tile: these rows lead a scan. */
  icon?: ReactNode;
  /** Reported state, right aligned before the chevron. */
  value?: ReactNode;
  /** A control in place of a value, such as a keycap cluster. */
  control?: ReactNode;
  /** The row it reports needs setting up, and the tile should say so. */
  attention?: boolean;
};

/**
 * The row's title with its explanation, when it has one.
 *
 * The glyph is `aria-hidden` and the tooltip is attached to the *title text*
 * rather than to the glyph's own box: hovering the words works as well as
 * hovering the dot, and a screen reader hears the explanation as the row's
 * description instead of as a stray control named "info". MUI wires
 * `aria-describedby` from the tooltip to whatever it wraps, and the glyph is
 * inside that wrapper.
 */
const RowTitle = ({
  title,
  tooltip,
}: {
  title: ReactNode;
  tooltip?: ReactNode;
}) => {
  if (!tooltip) {
    return <>{title}</>;
  }
  return (
    <Tooltip title={tooltip} placement="top" enterDelay={400}>
      <Box
        component="span"
        sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}
      >
        {title}
        <Box
          aria-hidden
          component="span"
          sx={{ display: "inline-flex", color: "text.disabled" }}
        >
          <Info size={15} strokeWidth={1.9} />
        </Box>
      </Box>
    </Tooltip>
  );
};

/**
 * Where a summary row goes, or null when it has nowhere to go.
 *
 * The rule lives here rather than inline: a row that reports a setting opens
 * that setting's own row, a row that opens a page takes the page, and a
 * setting the registry no longer knows about resolves to nothing. The last
 * case is why this returns null instead of a string — see the component.
 *
 * Both spellings are optional here rather than a union because the caller has
 * already destructured its props; the union on `SettingSummaryTarget` is what
 * stops a row being given both at the call site.
 */
const summaryTarget = (
  linksTo: string | undefined,
  path: string | undefined,
): string | null => {
  const entry = linksTo ? settingEntryOf(linksTo) : undefined;
  if (entry) {
    return `${settingsPagePath(entry.page)}#${settingAnchorId(entry.key)}`;
  }
  return path ?? null;
};

/**
 * A row that reports a setting living on another page, and links to it.
 *
 * It shares the row chassis with `SettingRow` — the same height, padding,
 * hover, press and focus treatment, and the same control column alignment — so
 * a summary cannot drift from the rows it summarizes. What it does not share is
 * the anchor: see `linksTo`.
 */
export const SettingSummaryRow = ({
  linksTo,
  path,
  subtitle,
  title,
  tooltip,
  icon,
  value,
  control,
  attention,
}: SettingSummaryRowProps) => {
  const navigate = useNavigate();
  const to = summaryTarget(linksTo, path);

  // A summary whose setting no longer exists would link nowhere, so it renders
  // nothing rather than a row that looks actionable and is not.
  if (!to) {
    return null;
  }

  return (
    <Box
      component="button"
      type="button"
      onClick={() => navigate(to)}
      sx={[rowSx, interactiveSx]}
    >
      {icon && (
        <Box
          aria-hidden
          sx={[summaryIconTileSx, ...(attention ? [attentionTileSx] : [])]}
        >
          {icon}
        </Box>
      )}
      {/* No label ids: this row is its own control, so it is named by the
          title, tooltip and value it renders, in that order. */}
      <SettingRowText
        subtitle={subtitle}
        title={<RowTitle title={title} tooltip={tooltip} />}
      />
      <Box sx={contentControlColumnSx}>
        {value != null && (
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
        )}
        {control}
        <TrailingGlyph>
          <ChevronRight size={20} strokeWidth={1.9} />
        </TrailingGlyph>
      </Box>
    </Box>
  );
};
