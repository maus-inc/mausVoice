import { Typography } from "@mui/material";
import { FormattedMessage } from "react-intl";
import { useAppStore } from "../../../store";
import { getIsAssistantModeEnabled } from "../../../utils/assistant-mode.utils";
import { getEffectiveStylingMode } from "../../../utils/feature.utils";
import { getHotkeyCombosForAction } from "../../../utils/keyboard.utils";
import { HotkeyBadge } from "../../common/HotkeyBadge";
import { SettingGroup, SettingGroupLink } from "../SettingRow";
import { SettingSummaryRow } from "../SettingSummaryRow";
import { settingsPagePath } from "../settings-routes";
import { QUICK_SHORTCUTS, SHORTCUT_COPY } from "../shortcut-copy";

/**
 * The combo currently bound to one action, or the fact that none is.
 *
 * Read with the same selector the shortcuts dialog uses, so the card cannot
 * report a key the dialog does not show — including the platform defaults a
 * fresh install runs on.
 */
const BoundHotkeys = ({ action }: { action: string }) => {
  const combo = useAppStore(
    (state) => getHotkeyCombosForAction(state, action)[0] ?? null,
  );

  if (!combo) {
    return (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        <FormattedMessage defaultMessage="Not set" />
      </Typography>
    );
  }

  return <HotkeyBadge keys={combo} />;
};

/**
 * The keys someone reaches for without opening settings.
 *
 * Which ones belong here is decided by frequency rather than by what the dialog
 * happens to list: cancelling a session and adding a word to the dictionary are
 * things that happen mid-thought, while opening the chat window only means
 * anything when assistant mode is on — so that row is the one that comes and
 * goes with a mode. The style keys join it only while styling is manual, which
 * is the only time they exist.
 */
export const QuickShortcutsCard = () => {
  const assistantMode = useAppStore(getIsAssistantModeEnabled);
  const manualStyling = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );

  const dictationRows = QUICK_SHORTCUTS.filter(
    (row) => assistantMode || row.action !== SHORTCUT_COPY.openChat.action,
  );

  return (
    <SettingGroup
      title={<FormattedMessage defaultMessage="Shortcuts" />}
      action={
        <SettingGroupLink to={settingsPagePath("shortcuts")}>
          <FormattedMessage defaultMessage="All shortcuts" />
        </SettingGroupLink>
      }
    >
      {dictationRows.map((row) => (
        <SettingSummaryRow
          key={row.action}
          linksTo="hotkey_shortcuts"
          title={row.title}
          tooltip={row.description}
          control={<BoundHotkeys action={row.action} />}
        />
      ))}
      {manualStyling &&
        [SHORTCUT_COPY.previousStyle, SHORTCUT_COPY.nextStyle].map((row) => (
          <SettingSummaryRow
            key={row.action}
            linksTo="hotkey_shortcuts"
            title={row.title}
            tooltip={row.description}
            control={<BoundHotkeys action={row.action} />}
          />
        ))}
    </SettingGroup>
  );
};
