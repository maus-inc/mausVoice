import type { SelectChangeEvent } from "@mui/material";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
} from "@mui/material";
import type {
  DictationPillVisibility,
  PillResetMonitorStrategy,
  StylingMode,
} from "@maus-inc/types";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  setDictationLimitMinutes,
  setDictationPillVisibility,
  setPillResetMonitorStrategy,
  setSpokenCommandsEnabled,
  setIgnoreUpdateDialog,
  setIncognitoModeEnabled,
  setInDictationStyleSwitchingEnabled,
  setHallucinationFilterEnabled,
  setReviewBeforeInsert,
  setIncognitoModeIncludeInStats,
  setMenuBarIconHidden,
  setRealtimeOutputEnabled,
  setStylingMode,
} from "../../actions/user.actions";
import { produceAppState, useAppStore } from "../../store";
import {
  getEffectiveDictationLimitMinutes,
  MAX_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { SegmentedControl } from "../common/SegmentedControl";
import { SettingSection } from "../common/SettingSection";
import { UpdateSettingSection } from "./UpdateSettingSection";

export const MoreSettingsDialog = () => {
  const intl = useIntl();
  const [
    open,
    ignoreUpdateDialog,
    incognitoModeEnabled,
    incognitoIncludeInStats,
    dictationPillVisibility,
    pillResetMonitorStrategy,
    realtimeOutputEnabled,
    stylingMode,
    canChangeStylingMode,
    showDictationLimitSetting,
    dictationLimitMinutes,
    disablePillRewards,
    disableAutoStyleLoading,
    menuBarIconHidden,
    spokenCommandsEnabled,
    inDictationStyleSwitchingEnabled,
    hallucinationFilterEnabled,
    reviewBeforeInsert,
  ] = useAppStore((state) => {
    const prefs = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);
    return [
      state.settings.moreSettingsDialogOpen,
      prefs?.ignoreUpdateDialog ?? false,
      prefs?.incognitoModeEnabled ?? false,
      prefs?.incognitoModeIncludeInStats ?? false,
      getEffectivePillVisibility(prefs?.dictationPillVisibility),
      prefs?.pillResetMonitorStrategy ?? "current",
      prefs?.realtimeOutputEnabled ?? false,
      getEffectiveStylingMode(state),
      true,
      shouldEnableDictationLimit(transcriptionPrefs.mode),
      getEffectiveDictationLimitMinutes(prefs),
      state.local.disablePillRewards,
      state.local.disableAutoStyleLoading ?? false,
      prefs?.menuBarIconHidden ?? false,
      prefs?.spokenCommandsEnabled ?? true,
      prefs?.inDictationStyleSwitchingEnabled ?? false,
      prefs?.hallucinationFilterEnabled ?? true,
      prefs?.reviewBeforeInsert ?? false,
    ] as const;
  });
  const [dictationLimitInput, setDictationLimitInput] = useState(
    String(dictationLimitMinutes),
  );
  const lastCommittedDictationLimitMinutesRef = useRef(dictationLimitMinutes);

  useEffect(() => {
    lastCommittedDictationLimitMinutesRef.current = dictationLimitMinutes;
    if (open) {
      setDictationLimitInput(String(dictationLimitMinutes));
    }
  }, [dictationLimitMinutes, open]);

  const commitDictationLimitInput = () => {
    if (!showDictationLimitSetting) {
      return;
    }

    if (dictationLimitInput === "") {
      setDictationLimitInput(String(dictationLimitMinutes));
      return;
    }

    const parsed = Number(dictationLimitInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDictationLimitInput(String(dictationLimitMinutes));
      return;
    }

    const normalized = normalizeDictationLimitMinutes(parsed);
    setDictationLimitInput(String(normalized));
    if (normalized === lastCommittedDictationLimitMinutesRef.current) {
      return;
    }

    lastCommittedDictationLimitMinutesRef.current = normalized;
    void setDictationLimitMinutes(normalized);
  };

  const handleClose = () => {
    commitDictationLimitInput();
    produceAppState((draft) => {
      draft.settings.moreSettingsDialogOpen = false;
    });
  };

  const handleToggleShowUpdates = (event: ChangeEvent<HTMLInputElement>) => {
    const showUpdates = event.target.checked;
    void setIgnoreUpdateDialog(!showUpdates);
  };

  const handleToggleIncognitoMode = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    void setIncognitoModeEnabled(enabled);
  };

  const handleToggleIncognitoIncludeInStats = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const enabled = event.target.checked;
    void setIncognitoModeIncludeInStats(enabled);
  };

  const handleDictationPillVisibilityChange = (
    event: SelectChangeEvent<DictationPillVisibility>,
  ) => {
    const visibility = event.target.value as DictationPillVisibility;
    void setDictationPillVisibility(visibility);
  };

  const handlePillResetMonitorStrategyChange = (
    strategy: PillResetMonitorStrategy,
  ) => {
    void setPillResetMonitorStrategy(strategy);
  };

  const handleToggleRealtimeOutput = (event: ChangeEvent<HTMLInputElement>) => {
    void setRealtimeOutputEnabled(event.target.checked);
  };

  const handleToggleSpokenCommands = (event: ChangeEvent<HTMLInputElement>) => {
    void setSpokenCommandsEnabled(event.target.checked);
  };

  const handleToggleInDictationStyleSwitching = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    void setInDictationStyleSwitchingEnabled(event.target.checked);
  };

  const handleToggleHallucinationFilter = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    void setHallucinationFilterEnabled(event.target.checked);
  };

  const handleToggleReviewBeforeInsert = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    void setReviewBeforeInsert(event.target.checked);
  };

  const handleToggleDisablePillRewards = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disablePillRewards = !event.target.checked;
    });
  };

  const handleToggleMenuBarIcon = (event: ChangeEvent<HTMLInputElement>) => {
    void setMenuBarIconHidden(!event.target.checked);
  };

  const handleToggleAutoStyleLoading = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disableAutoStyleLoading = !event.target.checked;
    });
  };

  const handleDictationLimitChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setDictationLimitInput(value);
  };

  const handleDictationLimitBlur = () => {
    commitDictationLimitInput();
  };

  const allowMultiDevice = true;

  const handleStylingModeChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    void setStylingMode(value === "" ? null : (value as StylingMode));
  };

  const openMultiDeviceDialog = () => {
    handleClose();
    produceAppState((draft) => {
      draft.settings.multiDeviceDialogOpen = true;
    });
  };

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>
        <FormattedMessage defaultMessage="More settings" />
      </DialogTitle>
      <DialogContent dividers sx={{ minWidth: 360 }}>
        <Stack spacing={3}>
          <SettingSection
            title={<FormattedMessage defaultMessage="Incognito mode" />}
            description={
              <FormattedMessage defaultMessage="When enabled, mausVoice will not save transcription history or audio snapshots." />
            }
            action={
              <Switch
                edge="end"
                checked={incognitoModeEnabled}
                onChange={handleToggleIncognitoMode}
              />
            }
          />

          {incognitoModeEnabled && (
            <SettingSection
              title={
                <FormattedMessage defaultMessage="Include incognito in stats" />
              }
              description={
                <FormattedMessage defaultMessage="If enabled, words dictated in incognito mode will still count toward your usage statistics." />
              }
              action={
                <Switch
                  edge="end"
                  checked={incognitoIncludeInStats}
                  onChange={handleToggleIncognitoIncludeInStats}
                />
              }
            />
          )}

          <UpdateSettingSection />

          <SettingSection
            title={
              <FormattedMessage defaultMessage="Automatically show updates" />
            }
            description={
              <FormattedMessage defaultMessage="Automatically open the update window when a new version is available." />
            }
            action={
              <Switch
                edge="end"
                checked={!ignoreUpdateDialog}
                onChange={handleToggleShowUpdates}
              />
            }
          />

          <SettingSection
            title={<FormattedMessage defaultMessage="Show menu bar icon" />}
            description={
              <FormattedMessage defaultMessage="Show the mausVoice icon in the menu bar." />
            }
            action={
              <Switch
                edge="end"
                checked={!menuBarIconHidden}
                onChange={handleToggleMenuBarIcon}
              />
            }
          />

          <SettingSection
            title={
              <FormattedMessage defaultMessage="Dictation pill visibility" />
            }
            description={
              <FormattedMessage defaultMessage="Control when the dictation pill is shown on screen." />
            }
            action={
              <Select<DictationPillVisibility>
                size="small"
                value={dictationPillVisibility}
                onChange={handleDictationPillVisibilityChange}
                sx={{ minWidth: 152 }}
              >
                <MenuItem value="persistent">
                  {intl.formatMessage({ defaultMessage: "Persistent" })}
                </MenuItem>
                <MenuItem value="while_active">
                  {intl.formatMessage({ defaultMessage: "While active" })}
                </MenuItem>
                <MenuItem value="hidden">
                  {intl.formatMessage({ defaultMessage: "Hidden" })}
                </MenuItem>
              </Select>
            }
          />

          <SettingSection
            title={<FormattedMessage defaultMessage="Reset pill position" />}
            description={
              <FormattedMessage defaultMessage="Choose which monitor the pill returns to when you reset its position: the monitor the pill is on, or the monitor your mouse is on." />
            }
            action={
              <SegmentedControl<PillResetMonitorStrategy>
                value={pillResetMonitorStrategy}
                onChange={handlePillResetMonitorStrategyChange}
                options={[
                  { value: "current", label: "Current monitor" },
                  { value: "cursor", label: "Cursor monitor" },
                ]}
                ariaLabel="Reset pill position monitor"
              />
            }
          />

          <SettingSection
            title={<FormattedMessage defaultMessage="Spoken commands" />}
            description={
              <FormattedMessage defaultMessage='Turn phrases like "new line", "comma", and "scratch that" into formatting, even in Verbatim. Requires an English dictation language — Auto does not apply these commands.' />
            }
            action={
              <Switch
                edge="end"
                checked={spokenCommandsEnabled}
                onChange={handleToggleSpokenCommands}
              />
            }
          />

          <SettingSection
            title={<FormattedMessage defaultMessage="Real-time output" />}
            description={
              <FormattedMessage defaultMessage="Stream dictation text as you speak instead of pasting all at once when you stop. Verbatim and a supported provider only. Punctuation commands apply live. Scratch-that and new-line apply to the saved transcript on release — they cannot rewrite text already streamed into the app." />
            }
            action={
              <Switch
                edge="end"
                checked={realtimeOutputEnabled}
                onChange={handleToggleRealtimeOutput}
              />
            }
          />

          <SettingSection
            title={<FormattedMessage defaultMessage="Review before insert" />}
            description={
              <FormattedMessage defaultMessage="Open an editable composer so you can review or change dictated text before it is inserted." />
            }
            action={
              <Switch
                edge="end"
                checked={reviewBeforeInsert}
                onChange={handleToggleReviewBeforeInsert}
              />
            }
          />

          <SettingSection
            title={
              <FormattedMessage defaultMessage="Silence hallucination filter" />
            }
            description={
              <FormattedMessage defaultMessage="Discard common fabricated phrases produced when the microphone hears silence or noise." />
            }
            action={
              <Switch
                edge="end"
                checked={hallucinationFilterEnabled}
                onChange={handleToggleHallucinationFilter}
              />
            }
          />

          <SettingSection
            title={
              <FormattedMessage defaultMessage="Switch style while dictating" />
            }
            description={
              <FormattedMessage defaultMessage="Hold the dictate activation key and press Left or Right Arrow to cycle active styles." />
            }
            action={
              <Switch
                edge="end"
                checked={inDictationStyleSwitchingEnabled}
                onChange={handleToggleInDictationStyleSwitching}
              />
            }
          />

          <SettingSection
            title={<FormattedMessage defaultMessage="Streak celebrations" />}
            description={
              <FormattedMessage defaultMessage="Show flame and firework animations on the dictation pill for streak milestones." />
            }
            action={
              <Switch
                edge="end"
                checked={!disablePillRewards}
                onChange={handleToggleDisablePillRewards}
              />
            }
          />

          {showDictationLimitSetting && (
            <SettingSection
              title={
                <FormattedMessage defaultMessage="Dictation limit (minutes)" />
              }
              description={
                <FormattedMessage defaultMessage="Set the maximum dictation length in minutes. Enter 0 for no limit." />
              }
              action={
                <TextField
                  size="small"
                  type="number"
                  value={dictationLimitInput}
                  onChange={handleDictationLimitChange}
                  onBlur={handleDictationLimitBlur}
                  sx={{ width: 104 }}
                  slotProps={{
                    htmlInput: {
                      min: 0,
                      max: MAX_DICTATION_LIMIT_MINUTES,
                      step: 1,
                      inputMode: "numeric",
                    },
                  }}
                />
              }
            />
          )}

          {stylingMode === "manual" && (
            <SettingSection
              title={
                <FormattedMessage defaultMessage="Automatic style loading" />
              }
              description={
                <FormattedMessage defaultMessage="Automatically load the manual style configured for the current app when starting dictation." />
              }
              action={
                <Switch
                  edge="end"
                  checked={!disableAutoStyleLoading}
                  onChange={handleToggleAutoStyleLoading}
                />
              }
            />
          )}

          {canChangeStylingMode && (
            <SettingSection
              title={<FormattedMessage defaultMessage="Styling mode" />}
              description={
                <FormattedMessage defaultMessage="Choose how to switch between writing styles." />
              }
              action={
                <Select<string>
                  size="small"
                  value={stylingMode}
                  onChange={handleStylingModeChange}
                  sx={{ minWidth: 152 }}
                >
                  <MenuItem value="app">
                    {intl.formatMessage({ defaultMessage: "Based on app" })}
                  </MenuItem>
                  <MenuItem value="manual">
                    {intl.formatMessage({ defaultMessage: "Manual" })}
                  </MenuItem>
                </Select>
              }
            />
          )}

          {allowMultiDevice && (
            <SettingSection
              title={<FormattedMessage defaultMessage="Multi-device" />}
              description={
                <FormattedMessage defaultMessage="Pair and manage remote devices for dictation." />
              }
              action={
                <Button size="small" onClick={openMultiDeviceDialog}>
                  <FormattedMessage defaultMessage="Configure" />
                </Button>
              }
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>
          <FormattedMessage defaultMessage="Close" />
        </Button>
      </DialogActions>
    </Dialog>
  );
};
