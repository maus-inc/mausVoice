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
<<<<<<< HEAD
  setHandsFreeDelayMs,
=======
  setSpokenCommandsEnabled,
>>>>>>> origin/fix/superfix-review-findings
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
import {
  getEffectiveHandsFreeDelayMs,
  MAX_HANDS_FREE_DELAY_MS,
} from "../../utils/hands-free-delay.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { PillPlacementSetting } from "./PillPlacementSetting";
import { SegmentedControl } from "../common/SegmentedControl";
import { logOnRejection } from "../../utils/promise.utils";
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
<<<<<<< HEAD
    handsFreeDelayMs,
=======
    spokenCommandsEnabled,
    inDictationStyleSwitchingEnabled,
    hallucinationFilterEnabled,
    reviewBeforeInsert,
>>>>>>> origin/fix/superfix-review-findings
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
<<<<<<< HEAD
      getEffectiveHandsFreeDelayMs(prefs),
=======
      prefs?.spokenCommandsEnabled ?? true,
      prefs?.inDictationStyleSwitchingEnabled ?? false,
      prefs?.hallucinationFilterEnabled ?? true,
      prefs?.reviewBeforeInsert ?? false,
>>>>>>> origin/fix/superfix-review-findings
    ] as const;
  });
  const [dictationLimitInput, setDictationLimitInput] = useState(
    String(dictationLimitMinutes),
  );
  const lastCommittedDictationLimitMinutesRef = useRef(dictationLimitMinutes);
  const [handsFreeDelayInput, setHandsFreeDelayInput] = useState(
    String(handsFreeDelayMs),
  );
  const lastCommittedHandsFreeDelayMsRef = useRef(handsFreeDelayMs);

  useEffect(() => {
    lastCommittedDictationLimitMinutesRef.current = dictationLimitMinutes;
    if (open) {
      setDictationLimitInput(String(dictationLimitMinutes));
    }
  }, [dictationLimitMinutes, open]);

  useEffect(() => {
    lastCommittedHandsFreeDelayMsRef.current = handsFreeDelayMs;
    if (open) {
      setHandsFreeDelayInput(String(handsFreeDelayMs));
    }
  }, [handsFreeDelayMs, open]);

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
    logOnRejection(
      setDictationLimitMinutes(normalized),
      "settings dialog: setDictationLimitMinutes",
    );
  };

  const handleClose = () => {
    commitDictationLimitInput();
    commitHandsFreeDelayInput();
    produceAppState((draft) => {
      draft.settings.moreSettingsDialogOpen = false;
    });
  };

  const handleToggleShowUpdates = (event: ChangeEvent<HTMLInputElement>) => {
    const showUpdates = event.target.checked;
    logOnRejection(
      setIgnoreUpdateDialog(!showUpdates),
      "settings dialog: setIgnoreUpdateDialog",
    );
  };

  const handleToggleIncognitoMode = (event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    logOnRejection(
      setIncognitoModeEnabled(enabled),
      "settings dialog: setIncognitoModeEnabled",
    );
  };

  const handleToggleIncognitoIncludeInStats = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const enabled = event.target.checked;
    logOnRejection(
      setIncognitoModeIncludeInStats(enabled),
      "settings dialog: setIncognitoModeIncludeInStats",
    );
  };

  const handleDictationPillVisibilityChange = (
    event: SelectChangeEvent<DictationPillVisibility>,
  ) => {
    const visibility = event.target.value as DictationPillVisibility;
    logOnRejection(
      setDictationPillVisibility(visibility),
      "settings dialog: setDictationPillVisibility",
    );
  };

  const handlePillResetMonitorStrategyChange = (
    strategy: PillResetMonitorStrategy,
  ) => {
    logOnRejection(
      setPillResetMonitorStrategy(strategy),
      "settings dialog: setPillResetMonitorStrategy",
    );
  };

  const handleToggleRealtimeOutput = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setRealtimeOutputEnabled(event.target.checked),
      "settings dialog: setRealtimeOutputEnabled",
    );
  };

  const handleToggleSpokenCommands = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setSpokenCommandsEnabled(event.target.checked),
      "settings dialog: setSpokenCommandsEnabled",
    );
  };

  const handleToggleInDictationStyleSwitching = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setInDictationStyleSwitchingEnabled(event.target.checked),
      "settings dialog: setInDictationStyleSwitchingEnabled",
    );
  };

  const handleToggleHallucinationFilter = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setHallucinationFilterEnabled(event.target.checked),
      "settings dialog: setHallucinationFilterEnabled",
    );
  };

  const handleToggleReviewBeforeInsert = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    logOnRejection(
      setReviewBeforeInsert(event.target.checked),
      "settings dialog: setReviewBeforeInsert",
    );
  };

  const handleToggleDisablePillRewards = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disablePillRewards = !event.target.checked;
    });
  };

  const handleToggleMenuBarIcon = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setMenuBarIconHidden(!event.target.checked),
      "settings dialog: setMenuBarIconHidden",
    );
  };

  const handleToggleAutoStyleLoading = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    produceAppState((draft) => {
      draft.local.disableAutoStyleLoading = !event.target.checked;
    });
  };

  const commitHandsFreeDelayInput = () => {
    if (handsFreeDelayInput === "") {
      setHandsFreeDelayInput(String(handsFreeDelayMs));
      return;
    }

    const parsed = Number(handsFreeDelayInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setHandsFreeDelayInput(String(handsFreeDelayMs));
      return;
    }

    const normalized = Math.min(
      MAX_HANDS_FREE_DELAY_MS,
      Math.max(0, Math.floor(parsed)),
    );
    setHandsFreeDelayInput(String(normalized));
    if (normalized === lastCommittedHandsFreeDelayMsRef.current) {
      return;
    }

    lastCommittedHandsFreeDelayMsRef.current = normalized;
    void setHandsFreeDelayMs(normalized);
  };

  const handleHandsFreeDelayChange = (event: ChangeEvent<HTMLInputElement>) => {
    setHandsFreeDelayInput(event.target.value);
  };

  const handleHandsFreeDelayBlur = () => {
    commitHandsFreeDelayInput();
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
    logOnRejection(
      setStylingMode(value === "" ? null : (value as StylingMode)),
      "settings dialog: setStylingMode",
    );
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

          <PillPlacementSetting />

          <SettingSection
            title={<FormattedMessage defaultMessage="Spoken commands" />}
            description={
              <FormattedMessage defaultMessage='Turn phrases like "new line", "comma", and "scratch that" into formatting, even in Verbatim. Requires an English dictation language; Auto does not apply these commands.' />
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
              <FormattedMessage defaultMessage="Stream dictation text as you speak instead of pasting all at once when you stop. Verbatim and a supported provider only. Punctuation commands apply live. Scratch-that and new-line apply to the saved transcript on release; they cannot rewrite text already streamed into the app. Real-time streaming skips Review before insert, so turning one on turns the other off." />
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
              <FormattedMessage defaultMessage="Open an editable composer so you can review or change dictated text before it is inserted. Review pauses streaming, so turning this on turns Real-time output off." />
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

          <SettingSection
            title={
              <FormattedMessage defaultMessage="Hands-free output delay (ms)" />
            }
            description={
              <FormattedMessage defaultMessage="Wait this many milliseconds before inserting the dictated text when you stop recording. Enter 0 to disable." />
            }
            action={
              <TextField
                size="small"
                type="number"
                value={handsFreeDelayInput}
                onChange={handleHandsFreeDelayChange}
                onBlur={handleHandsFreeDelayBlur}
                sx={{ width: 104 }}
                slotProps={{
                  htmlInput: {
                    min: 0,
                    max: MAX_HANDS_FREE_DELAY_MS,
                    step: 50,
                    inputMode: "numeric",
                  },
                }}
              />
            }
          />

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
