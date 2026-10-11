import { ChevronRight } from "lucide-react";
import { Box, Typography, type Theme } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { settingEntryOf } from "../../utils/settings-registry";
import { settingAnchorId, settingsPagePath } from "./settings-routes";
import {
  interactiveSx,
  rowSx,
  summaryControlColumnSx,
  SettingRowText,
  TrailingGlyph,
} from "./setting-row-chassis";

/** The tile a summary row's leading glyph sits in. */
const summaryIconTileSx: SystemStyleObject<Theme> = {
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
 * The glyph tile of a row whose subject needs the person's attention: a
 * provider with no key, a model that is not downloaded. The row's own text
 * carries the state; the tint only agrees with it.
 */
const attentionTileSx: SystemStyleObject<Theme> = {
  color: "warning.main",
  borderColor: (theme: Theme) =>
    `rgb(${theme.vars?.palette?.warning.mainChannel} / 0.4)`,
};

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
  title: ReactNode;
  description?: ReactNode;
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
 * A row that reports a setting living on another page, and links to it.
 *
 * It shares the row chassis with `SettingRow` — the same height, padding,
 * hover, press and focus treatment, and the same control column alignment — so
 * a summary cannot drift from the rows it summarizes. What it does not share is
 * the anchor: see `linksTo`.
 */
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

export const SettingSummaryRow = ({
  linksTo,
  path,
  title,
  description,
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
          title, description and value it renders, in that order. */}
      <SettingRowText title={title} description={description} />
      <Box sx={summaryControlColumnSx}>
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
