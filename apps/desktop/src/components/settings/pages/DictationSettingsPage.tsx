import {
  AppsOutlined,
  LanguageOutlined,
  MicOutlined,
  VolumeUpOutlined,
  WarningAmberOutlined,
} from "@mui/icons-material";
import { Link, Stack, Typography } from "@mui/material";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { produceAppState, useAppStore } from "../../../store";
import {
  setDictationLimitMinutes,
  setHandsFreeDelayMs,
  setHallucinationFilterEnabled,
  setInDictationStyleSwitchingEnabled,
  setPreferredLanguage,
  setRealtimeOutputEnabled,
  setReviewBeforeInsert,
  setSpokenCommandsEnabled,
} from "../../../actions/user.actions";
import { loadTones } from "../../../actions/tone.actions";
import {
  MAX_DICTATION_LIMIT_MINUTES,
  getEffectiveDictationLimitMinutes,
  parseDictationLimitMinutes,
} from "../../../utils/dictation-limit.utils";
import {
  MAX_HANDS_FREE_DELAY_SECONDS,
  formatHandsFreeDelaySeconds,
  getEffectiveHandsFreeDelayMs,
  parseHandsFreeDelaySeconds,
} from "../../../utils/hands-free-delay.utils";
import {
  getDetectedSystemLocale,
  getGenerativePrefs,
  getMyUser,
  getMyUserPreferences,
} from "../../../utils/user.utils";
import {
  DICTATION_LANGUAGE_OPTIONS,
  KEYBOARD_LAYOUT_LANGUAGE,
  WHISPER_LANGUAGES,
} from "../../../utils/language.utils";
import { logOnRejection } from "../../../utils/promise.utils";
import { settingsPagePath, settingAnchorId } from "../settings-routes";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { SettingNumberField, SettingSelect } from "../SettingRowControls";
import { useSettingsAvailability } from "../settings-availability";

const openDialog = (
  key:
    | "microphoneDialogOpen"
    | "audioDialogOpen"
    | "appKeybindingsDialogOpen"
    | "dictationLanguageDialogOpen",
) => {
  produceAppState((draft) => {
    draft.settings[key] = true;
  });
};

export default function DictationSettingsPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const availability = useSettingsAvailability();

  const [
    dictationLanguage,
    spokenCommandsEnabled,
    hallucinationFilterEnabled,
    inDictationStyleSwitchingEnabled,
    realtimeOutputEnabled,
    reviewBeforeInsert,
    dictationLimitMinutes,
    handsFreeDelayMs,
    hasPostProcessing,
  ] = useAppStore((state) => {
    const preferences = getMyUserPreferences(state);
    const user = getMyUser(state);
    return [
      user?.preferredLanguage ?? getDetectedSystemLocale(),
      preferences?.spokenCommandsEnabled ?? true,
      preferences?.hallucinationFilterEnabled ?? true,
      preferences?.inDictationStyleSwitchingEnabled ?? false,
      preferences?.realtimeOutputEnabled ?? false,
      preferences?.reviewBeforeInsert ?? false,
      getEffectiveDictationLimitMinutes(preferences),
      getEffectiveHandsFreeDelayMs(preferences),
      getGenerativePrefs(state).mode !== "none",
    ] as const;
  });

  const languageWarning = (() => {
    if (hasPostProcessing || dictationLanguage === KEYBOARD_LAYOUT_LANGUAGE) {
      return null;
    }
    if (dictationLanguage in WHISPER_LANGUAGES) {
      return null;
    }
    return intl.formatMessage({
      defaultMessage:
        "Turn on AI post processing for the best results in this language.",
    });
  })();

  const handleLanguageChange = (nextValue: string) => {
    // `logOnRejection` rather than a bare `void`: `updateUser` shows the error
    // snackbar and then rethrows, so this chain rejects and `void` would leave
    // an unhandled rejection on top of the toast.
    logOnRejection(
      setPreferredLanguage(nextValue).then(() => {
        loadTones();
      }),
      "settings: setPreferredLanguage",
    );
  };

  const [limitInput, setLimitInput] = useState(String(dictationLimitMinutes));
  const [limitError, setLimitError] = useState<string | null>(null);
  const lastCommittedLimit = useRef(dictationLimitMinutes);

  const [delayInput, setDelayInput] = useState(
    formatHandsFreeDelaySeconds(handsFreeDelayMs),
  );
  const [delayError, setDelayError] = useState<string | null>(null);
  const lastCommittedDelay = useRef(handsFreeDelayMs);

  useEffect(() => {
    lastCommittedLimit.current = dictationLimitMinutes;
    setLimitInput(String(dictationLimitMinutes));
    setLimitError(null);
  }, [dictationLimitMinutes]);

  useEffect(() => {
    lastCommittedDelay.current = handsFreeDelayMs;
    setDelayInput(formatHandsFreeDelaySeconds(handsFreeDelayMs));
    setDelayError(null);
  }, [handsFreeDelayMs]);

  const outOfRangeMessage = useCallback(
    (max: number) =>
      intl.formatMessage(
        {
          defaultMessage:
            "Enter a number between 0 and {max}. The value was not saved.",
        },
        { max: intl.formatNumber(max) },
      ),
    [intl],
  );

  const commitLimit = () => {
    const minutes = parseDictationLimitMinutes(limitInput);
    if (minutes === null) {
      setLimitError(outOfRangeMessage(MAX_DICTATION_LIMIT_MINUTES));
      return;
    }

    setLimitError(null);
    setLimitInput(String(minutes));
    if (minutes === lastCommittedLimit.current) {
      return;
    }
    lastCommittedLimit.current = minutes;
    logOnRejection(
      setDictationLimitMinutes(minutes),
      "settings page: setDictationLimitMinutes",
    );
  };

  const commitDelay = () => {
    const milliseconds = parseHandsFreeDelaySeconds(delayInput);
    if (milliseconds === null) {
      setDelayError(outOfRangeMessage(MAX_HANDS_FREE_DELAY_SECONDS));
      return;
    }

    setDelayError(null);
    setDelayInput(formatHandsFreeDelaySeconds(milliseconds));
    if (milliseconds === lastCommittedDelay.current) {
      return;
    }
    lastCommittedDelay.current = milliseconds;
    logOnRejection(
      setHandsFreeDelayMs(milliseconds),
      "settings page: setHandsFreeDelayMs",
    );
  };

  const togglePageSetting =
    (action: (enabled: boolean) => Promise<void> | void, label: string) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      logOnRejection(Promise.resolve(action(event.target.checked)), label);
    };

  return (
    <>
      <SettingGroup
        title={<FormattedMessage defaultMessage="Microphone and feedback" />}
      >
        <SettingRow
          settingKey="microphone"
          title={<FormattedMessage defaultMessage="Microphone" />}
          description={
            <FormattedMessage defaultMessage="Which input captures your voice, and how it is tested." />
          }
          icon={<MicOutlined />}
          onClick={() => openDialog("microphoneDialogOpen")}
        />
        <SettingRow
          settingKey="audio"
          title={<FormattedMessage defaultMessage="Audio" />}
          description={
            <FormattedMessage defaultMessage="The chime that marks recording start and stop, and how far everything else dims while you speak." />
          }
          icon={<VolumeUpOutlined />}
          onClick={() => openDialog("audioDialogOpen")}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Language" />}>
        <SettingRow
          settingKey="dictation_language"
          title={<FormattedMessage defaultMessage="Dictation language" />}
          description={
            languageWarning ? (
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ alignItems: "center", color: "warning.main" }}
              >
                <WarningAmberOutlined sx={{ fontSize: 16 }} />
                <Typography variant="body2" component="span">
                  {languageWarning}{" "}
                  <Link
                    component="button"
                    type="button"
                    color="inherit"
                    sx={{ verticalAlign: "baseline" }}
                    onClick={() =>
                      navigate(
                        `${settingsPagePath("ai-models")}#${settingAnchorId("ai_post_processing")}`,
                      )
                    }
                  >
                    <FormattedMessage defaultMessage="Fix issue" />
                  </Link>
                </Typography>
              </Stack>
            ) : (
              <FormattedMessage defaultMessage="The language mausVoice expects to hear. Auto follows your system language." />
            )
          }
          control={
            <SettingSelect
              value={dictationLanguage}
              ariaLabel={intl.formatMessage({
                defaultMessage: "Dictation language",
              })}
              onChange={handleLanguageChange}
              options={DICTATION_LANGUAGE_OPTIONS.map(([value, label]) => ({
                value,
                label,
              }))}
            />
          }
        />
        <SettingRow
          settingKey="multiple_languages"
          title={<FormattedMessage defaultMessage="Multiple languages" />}
          description={
            <FormattedMessage defaultMessage="Give each language its own hotkey, so you can switch without coming back here." />
          }
          icon={<LanguageOutlined />}
          onClick={() => openDialog("dictationLanguageDialogOpen")}
        />
      </SettingGroup>

      <SettingGroup
        title={<FormattedMessage defaultMessage="While you dictate" />}
      >
        <SettingToggleRow
          settingKey="spoken_commands"
          title={<FormattedMessage defaultMessage="Spoken commands" />}
          description={
            <FormattedMessage defaultMessage='Turns phrases like "new line", "comma", and "scratch that" into formatting, even in Verbatim. Requires an English dictation language, because Auto does not apply them.' />
          }
          checked={spokenCommandsEnabled}
          onChange={togglePageSetting(
            setSpokenCommandsEnabled,
            "settings page: setSpokenCommandsEnabled",
          )}
        />
        <SettingToggleRow
          settingKey="silence_hallucination_filter"
          title={
            <FormattedMessage defaultMessage="Silence hallucination filter" />
          }
          description={
            <FormattedMessage defaultMessage="Discards the phrases transcription models invent when the microphone hears silence or noise." />
          }
          checked={hallucinationFilterEnabled}
          onChange={togglePageSetting(
            setHallucinationFilterEnabled,
            "settings page: setHallucinationFilterEnabled",
          )}
        />
        <SettingToggleRow
          settingKey="switch_style_while_dictating"
          title={
            <FormattedMessage defaultMessage="Switch style while dictating" />
          }
          description={
            <FormattedMessage defaultMessage="Hold the dictation key and press Left or Right Arrow to cycle the active styles." />
          }
          checked={inDictationStyleSwitchingEnabled}
          onChange={togglePageSetting(
            setInDictationStyleSwitchingEnabled,
            "settings page: setInDictationStyleSwitchingEnabled",
          )}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Output" />}>
        <SettingRow
          settingKey="text_insertion_options"
          title={<FormattedMessage defaultMessage="Text insertion options" />}
          description={
            <FormattedMessage defaultMessage="Choose paste or simulated typing, globally and per app." />
          }
          icon={<AppsOutlined />}
          onClick={() => openDialog("appKeybindingsDialogOpen")}
        />
        <SettingToggleRow
          settingKey="real_time_output"
          title={<FormattedMessage defaultMessage="Real-time output" />}
          description={
            <FormattedMessage defaultMessage="Streams dictation text as you speak instead of pasting it all when you stop. Applies to Verbatim mode on supported providers." />
          }
          checked={realtimeOutputEnabled}
          onChange={togglePageSetting(
            setRealtimeOutputEnabled,
            "settings page: setRealtimeOutputEnabled",
          )}
        />
        <SettingToggleRow
          settingKey="review_before_insert"
          title={<FormattedMessage defaultMessage="Review before insert" />}
          description={
            <FormattedMessage defaultMessage="Opens an editable panel so you can review or change dictated text before it is inserted. Review pauses streaming, so turning this on turns Real-time output off." />
          }
          checked={reviewBeforeInsert}
          onChange={togglePageSetting(
            setReviewBeforeInsert,
            "settings page: setReviewBeforeInsert",
          )}
        />
        {availability.dictation_limit && (
          <SettingRow
            settingKey="dictation_limit"
            title={<FormattedMessage defaultMessage="Dictation limit" />}
            description={
              <FormattedMessage defaultMessage="Stops a recording that runs too long. Use 0 for no limit." />
            }
            control={
              <SettingNumberField
                value={limitInput}
                onChange={setLimitInput}
                onCommit={commitLimit}
                error={limitError}
                unit={intl.formatMessage({ defaultMessage: "min" })}
                min={0}
                max={MAX_DICTATION_LIMIT_MINUTES}
              />
            }
          />
        )}
        <SettingRow
          settingKey="hands_free_output_delay"
          title={<FormattedMessage defaultMessage="Hands-free output delay" />}
          description={
            <FormattedMessage defaultMessage="How long mausVoice waits after you stop speaking before it inserts the text, so you can keep talking. Use 0 to insert immediately." />
          }
          control={
            <SettingNumberField
              value={delayInput}
              onChange={setDelayInput}
              onCommit={commitDelay}
              error={delayError}
              unit={intl.formatMessage({ defaultMessage: "sec" })}
              min={0}
              max={MAX_HANDS_FREE_DELAY_SECONDS}
              step={0.5}
            />
          }
        />
      </SettingGroup>
    </>
  );
}
