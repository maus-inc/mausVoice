import type {
  DictationPillVisibility,
  PillResetMonitorStrategy,
} from "@maus-inc/types";
import { FormattedMessage, useIntl } from "react-intl";
import type { ChangeEvent } from "react";
import { produceAppState, useAppStore } from "../../../store";
import {
  setDictationPillVisibility,
  setMenuBarIconHidden,
  setPillResetMonitorStrategy,
} from "../../../actions/user.actions";
import { logOnRejection } from "../../../utils/promise.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
} from "../../../utils/user.utils";
import { SegmentedControl } from "../../common/SegmentedControl";
import { PillPlacementSetting } from "../PillPlacementSetting";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { useSettingsAvailability } from "../settings-availability";

export default function AppearanceSettingsPage() {
  const intl = useIntl();
  const availability = useSettingsAvailability();
  const [
    pillVisibility,
    pillResetMonitorStrategy,
    menuBarIconHidden,
    disablePillRewards,
  ] = useAppStore((state) => {
    const preferences = getMyUserPreferences(state);
    return [
      getEffectivePillVisibility(preferences?.dictationPillVisibility),
      preferences?.pillResetMonitorStrategy ?? "current",
      preferences?.menuBarIconHidden ?? false,
      state.local.disablePillRewards,
    ] as const;
  });

  const handleVisibilityChange = (value: DictationPillVisibility) => {
    logOnRejection(
      setDictationPillVisibility(value),
      "settings page: setDictationPillVisibility",
    );
  };

  const handleResetStrategyChange = (value: PillResetMonitorStrategy) => {
    logOnRejection(
      setPillResetMonitorStrategy(value),
      "settings page: setPillResetMonitorStrategy",
    );
  };

  const handleToggleMenuBarIcon = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setMenuBarIconHidden(!event.target.checked),
      "settings page: setMenuBarIconHidden",
    );
  };

  const handleTogglePillRewards = (event: ChangeEvent<HTMLInputElement>) => {
    produceAppState((draft) => {
      draft.local.disablePillRewards = !event.target.checked;
    });
  };

  return (
    <>
      <SettingGroup title={<FormattedMessage defaultMessage="Pill" />}>
        <SettingRow
          settingKey="dictation_pill_visibility"
          title={
            <FormattedMessage defaultMessage="Dictation pill visibility" />
          }
          description={
            <FormattedMessage defaultMessage="Persistent keeps the pill on screen, While active shows it only during a recording, and Hidden removes it entirely." />
          }
          control={
            <SegmentedControl<DictationPillVisibility>
              value={pillVisibility}
              onChange={handleVisibilityChange}
              options={[
                {
                  value: "persistent",
                  label: intl.formatMessage({
                    defaultMessage: "Persistent",
                  }),
                },
                {
                  value: "while_active",
                  label: intl.formatMessage({
                    defaultMessage: "While active",
                  }),
                },
                {
                  value: "hidden",
                  label: intl.formatMessage({ defaultMessage: "Hidden" }),
                },
              ]}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Dictation pill visibility",
              })}
            />
          }
        />
        {availability.pill_placement && <PillPlacementSetting />}
        <SettingRow
          settingKey="reset_pill_position"
          title={<FormattedMessage defaultMessage="Reset pill position" />}
          description={
            <FormattedMessage defaultMessage="Which screen the pill returns to when you reset its position from the tray. This does not move it now." />
          }
          control={
            <SegmentedControl<PillResetMonitorStrategy>
              value={pillResetMonitorStrategy}
              onChange={handleResetStrategyChange}
              options={[
                {
                  value: "current",
                  label: intl.formatMessage({
                    defaultMessage: "Current monitor",
                  }),
                },
                {
                  value: "cursor",
                  label: intl.formatMessage({
                    defaultMessage: "Cursor monitor",
                  }),
                },
              ]}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Reset pill position monitor",
              })}
            />
          }
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Menu bar" />}>
        <SettingToggleRow
          settingKey="show_menu_bar_icon"
          title={<FormattedMessage defaultMessage="Show menu bar icon" />}
          description={
            <FormattedMessage defaultMessage="Keeps the mausVoice icon in the menu bar. Leave another way to open the app before hiding it." />
          }
          checked={!menuBarIconHidden}
          onChange={handleToggleMenuBarIcon}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Celebrations" />}>
        <SettingToggleRow
          settingKey="streak_celebrations"
          title={<FormattedMessage defaultMessage="Streak celebrations" />}
          description={
            <FormattedMessage defaultMessage="Flame and firework animations on the pill when you hit a streak milestone." />
          }
          checked={!disablePillRewards}
          onChange={handleTogglePillRewards}
        />
      </SettingGroup>
    </>
  );
}
