import {
  Locate,
  Monitor,
  PanelTop,
  PartyPopper,
  AppWindow,
} from "lucide-react";
import type {
  DictationPillVisibility,
  PillLocateGestureModifier,
  PillResetMonitorStrategy,
} from "@maus-inc/types";
import { FormattedMessage, useIntl } from "react-intl";
import type { ChangeEvent } from "react";
import { produceAppState, useAppStore } from "../../../store";
import {
  setDictationPillVisibility,
  setMenuBarIconHidden,
  setPillLocateGestureModifier,
  setPillResetMonitorStrategy,
} from "../../../actions/user.actions";
import { logOnRejection } from "../../../utils/promise.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
} from "../../../utils/user.utils";
import { SegmentedControl } from "../../common/SegmentedControl";
import { PillLocateModifierSetting } from "../PillLocateModifierSetting";
import { PillPlacementSetting } from "../PillPlacementSetting";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { useSettingsAvailability } from "../settings-availability";
import { settingGlyphProps } from "../setting-row-chassis";

export default function AppearanceSettingsPage() {
  const intl = useIntl();
  const availability = useSettingsAvailability();
  const [
    pillVisibility,
    pillResetMonitorStrategy,
    pillLocateGestureModifier,
    menuBarIconHidden,
    disablePillRewards,
  ] = useAppStore((state) => {
    const preferences = getMyUserPreferences(state);
    return [
      getEffectivePillVisibility(preferences?.dictationPillVisibility),
      preferences?.pillResetMonitorStrategy ?? "current",
      preferences?.pillLocateGestureModifier ?? "none",
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

  const handleTogglePillLocateGesture = (value: PillLocateGestureModifier) => {
    logOnRejection(
      setPillLocateGestureModifier(value),
      "settings page: setPillLocateGestureModifier",
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
          icon={<AppWindow {...settingGlyphProps} />}
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
        {availability.show_pill_position_with_modifier_double_tap && (
          <SettingRow
            settingKey="show_pill_position_with_modifier_double_tap"
            title={
              <FormattedMessage defaultMessage="Show pill position with modifier double-tap" />
            }
            description={
              <FormattedMessage defaultMessage="Double-tap the chosen key to briefly highlight the current position of the mausVoice pill." />
            }
            icon={<Locate {...settingGlyphProps} />}
            control={
              <PillLocateModifierSetting
                value={pillLocateGestureModifier}
                onChange={handleTogglePillLocateGesture}
                ariaLabel={intl.formatMessage({
                  defaultMessage: "Pill position modifier",
                })}
              />
            }
          />
        )}
        <SettingRow
          settingKey="reset_pill_position"
          title={<FormattedMessage defaultMessage="Reset pill position" />}
          description={
            <FormattedMessage defaultMessage="Which screen the pill returns to when you reset its position from the tray. This does not move it now." />
          }
          icon={<Monitor {...settingGlyphProps} />}
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
          icon={<PanelTop {...settingGlyphProps} />}
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
          icon={<PartyPopper {...settingGlyphProps} />}
          checked={!disablePillRewards}
          onChange={handleTogglePillRewards}
        />
      </SettingGroup>
    </>
  );
}
