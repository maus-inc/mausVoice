import {
  ArrowLeftRight,
  Brush,
  EarOff,
  Globe,
  Hourglass,
  Keyboard,
  Languages,
  Mic,
  Pilcrow,
  Send,
  SquarePen,
  Timer,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import { Link, Stack, Typography } from "@mui/material";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { produceAppState, useAppStore } from "../../../store";
import type { AppState } from "../../../state/app.state";
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
import { setVoiceTypingTipEnabled } from "../../../actions/voice-typing-tip.actions";
import { loadTones } from "../../../actions/tone.actions";
import {
  VOICE_TYPING_TIP_SNOOZE_MS,
  getVoiceTypingTipSnoozeRemainingMs,
  isVoiceTypingTipSnoozed,
  type VoiceTypingTipLocalState,
} from "../../../utils/voice-typing-tip";
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
import { settingsPagePath, settingAnchorId } from "../settings-routes";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { SettingNumberField, SettingSelect } from "../SettingRowControls";
import { settingGlyphProps } from "../setting-row-chassis";
import { logOnRejection } from "../../../utils/promise.utils";
import { useSettingsAvailability } from "../settings-availability";
import { useSavedNumberField } from "../../../hooks/use-saved-number-field";

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
/**
 * The settings this page reads, in the order they are destructured below.
 *
 * Each one carries its own default, so the page never has to ask whether a
 * preference has been set. The store compares selector results deeply, so a
 * fresh tuple per call is the intended shape here.
 */
const selectDictationState = (state: AppState) => {
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
};

const useVoiceTypingTipStatus = (): {
  voiceTypingTip: VoiceTypingTipLocalState;
  snoozedUntilMs: number | null;
  snoozeMinutesLeft: number;
  autoDisabledByDismissLimit: boolean;
} => {
  const voiceTypingTip = useAppStore((state) => state.local.voiceTypingTip);
  const [statusClockMs, setStatusClockMs] = useState(() => Date.now());

  useEffect(() => {
    setStatusClockMs(Date.now());
    if (!voiceTypingTip.enabled || voiceTypingTip.snoozedUntilMs === null) {
      return;
    }
    const interval = setInterval(() => {
      setStatusClockMs(Date.now());
    }, 15_000);
    return () => clearInterval(interval);
  }, [voiceTypingTip.enabled, voiceTypingTip.snoozedUntilMs]);

  const snoozed = isVoiceTypingTipSnoozed(voiceTypingTip, statusClockMs);
  const snoozedUntilMs =
    snoozed && voiceTypingTip.snoozedUntilMs !== null
      ? Math.min(
          voiceTypingTip.snoozedUntilMs,
          statusClockMs + VOICE_TYPING_TIP_SNOOZE_MS,
        )
      : null;
  const snoozeMinutesLeft = Math.max(
    1,
    Math.ceil(
      getVoiceTypingTipSnoozeRemainingMs(voiceTypingTip, statusClockMs) /
        60_000,
    ),
  );
  const autoDisabledByDismissLimit =
    !voiceTypingTip.enabled &&
    voiceTypingTip.disabledReason === "auto_dismiss_limit";

  return {
    voiceTypingTip,
    snoozedUntilMs,
    snoozeMinutesLeft,
    autoDisabledByDismissLimit,
  };
};

export default function DictationSettingsPage() {
  const intl = useIntl();
  const navigate = useNavigate();
  const availability = useSettingsAvailability();
  const {
    voiceTypingTip,
    snoozedUntilMs,
    snoozeMinutesLeft,
    autoDisabledByDismissLimit,
  } = useVoiceTypingTipStatus();

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
  ] = useAppStore(selectDictationState);

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
      setPreferredLanguage(nextValue).then(async () => {
        // Awaited rather than fired and forgotten: the language changes which
        // tones are available, and the chain is what `logOnRejection` reports on.
        await loadTones();
      }),
      "settings: setPreferredLanguage",
    );
  };

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

  // The minutes field is stricter than the seconds field, so it gets its own
  // sentence: it refuses fractions, and "between 0 and 35791" would not say so.
  const wholeMinutesMessage = useCallback(
    (max: number) =>
      intl.formatMessage(
        {
          defaultMessage:
            "Enter a whole number of minutes from 0 to {max}. The value was not saved.",
        },
        { max: intl.formatNumber(max) },
      ),
    [intl],
  );

  const limitField = useSavedNumberField({
    saved: dictationLimitMinutes,
    format: String,
    parse: parseDictationLimitMinutes,
    save: setDictationLimitMinutes,
    invalidMessage: () => wholeMinutesMessage(MAX_DICTATION_LIMIT_MINUTES),
    context: "settings page: setDictationLimitMinutes",
  });

  const delayField = useSavedNumberField({
    saved: handsFreeDelayMs,
    format: formatHandsFreeDelaySeconds,
    parse: parseHandsFreeDelaySeconds,
    save: setHandsFreeDelayMs,
    invalidMessage: () => outOfRangeMessage(MAX_HANDS_FREE_DELAY_SECONDS),
    context: "settings page: setHandsFreeDelayMs",
  });

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
          icon={<Mic {...settingGlyphProps} />}
          onClick={() => openDialog("microphoneDialogOpen")}
        />
        <SettingRow
          settingKey="audio"
          title={<FormattedMessage defaultMessage="Audio" />}
          description={
            <FormattedMessage defaultMessage="The chime that marks recording start and stop, and how far everything else dims while you speak." />
          }
          icon={<Volume2 {...settingGlyphProps} />}
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
                {/* The one warning mark inside a row, drawn from the same
                    family as every other glyph on the page rather than from
                    the Material set, so the description's caution and the
                    row's icon share a stroke weight. */}
                <TriangleAlert size={16} strokeWidth={1.9} />
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
          icon={<Globe {...settingGlyphProps} />}
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
          icon={<Languages {...settingGlyphProps} />}
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
          icon={<Pilcrow {...settingGlyphProps} />}
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
          icon={<EarOff {...settingGlyphProps} />}
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
          icon={<Brush {...settingGlyphProps} />}
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
          icon={<ArrowLeftRight {...settingGlyphProps} />}
          onClick={() => openDialog("appKeybindingsDialogOpen")}
        />
        <SettingToggleRow
          settingKey="real_time_output"
          title={<FormattedMessage defaultMessage="Real-time output" />}
          description={
            <FormattedMessage defaultMessage="Streams dictation text as you speak instead of pasting it all when you stop. Applies to Verbatim mode on supported providers." />
          }
          checked={realtimeOutputEnabled}
          icon={<Send {...settingGlyphProps} />}
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
          icon={<SquarePen {...settingGlyphProps} />}
          onChange={togglePageSetting(
            setReviewBeforeInsert,
            "settings page: setReviewBeforeInsert",
          )}
        />
        {availability.dictation_limit && (
          <SettingRow
            settingKey="dictation_limit"
            title={
              <label htmlFor={`${settingAnchorId("dictation_limit")}-input`}>
                <FormattedMessage defaultMessage="Dictation limit" />
              </label>
            }
            icon={<Timer {...settingGlyphProps} />}
            description={
              <FormattedMessage defaultMessage="Stops a recording that runs too long. Use 0 for no limit." />
            }
            control={
              <SettingNumberField
                rowKey="dictation_limit"
                value={limitField.input}
                onChange={limitField.setInput}
                onCommit={limitField.commit}
                error={limitField.error}
                unit={intl.formatMessage({ defaultMessage: "min" })}
                min={0}
                max={MAX_DICTATION_LIMIT_MINUTES}
              />
            }
          />
        )}
        <SettingRow
          settingKey="hands_free_output_delay"
          icon={<Hourglass {...settingGlyphProps} />}
          title={
            <label
              htmlFor={`${settingAnchorId("hands_free_output_delay")}-input`}
            >
              <FormattedMessage defaultMessage="Hands-free output delay" />
            </label>
          }
          description={
            <FormattedMessage defaultMessage="How long mausVoice waits after you stop speaking before it inserts the text, so you can keep talking. Use 0 to insert immediately." />
          }
          control={
            <SettingNumberField
              rowKey="hands_free_output_delay"
              value={delayField.input}
              onChange={delayField.setInput}
              onCommit={delayField.commit}
              error={delayField.error}
              unit={intl.formatMessage({ defaultMessage: "sec" })}
              min={0}
              max={MAX_HANDS_FREE_DELAY_SECONDS}
              step={0.5}
            />
          }
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Reminders" />}>
        <SettingToggleRow
          settingKey="voice_typing_tip"
          title={<FormattedMessage defaultMessage="Voice typing tip" />}
          description={
            <Stack component="span" spacing={0.5} sx={{ display: "flex" }}>
              <Typography
                variant="body2"
                component="span"
                sx={{ color: "inherit" }}
              >
                <FormattedMessage defaultMessage="Shows a quiet tip after sustained typing to remind you that you can dictate instead." />
              </Typography>
              {snoozedUntilMs !== null && (
                <Typography
                  variant="caption"
                  component="span"
                  data-voice-typing-tip-status="snoozed"
                  sx={{ color: "text.secondary" }}
                >
                  <FormattedMessage
                    defaultMessage="Snoozed until {time} ({minutes, plural, one {# min left} other {# min left}})."
                    values={{
                      time: intl.formatTime(snoozedUntilMs, {
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                      minutes: snoozeMinutesLeft,
                    }}
                  />
                </Typography>
              )}
              {autoDisabledByDismissLimit && (
                <Typography
                  variant="caption"
                  component="span"
                  data-voice-typing-tip-status="auto-disabled"
                  sx={{ color: "text.secondary" }}
                >
                  <FormattedMessage defaultMessage='Turned off automatically after selecting "No thanks" 5 times in 7 days. Turn back on anytime.' />
                </Typography>
              )}
            </Stack>
          }
          icon={<Keyboard {...settingGlyphProps} />}
          checked={voiceTypingTip.enabled}
          onChange={togglePageSetting(
            (enabled) => setVoiceTypingTipEnabled(enabled),
            "settings page: setVoiceTypingTipEnabled",
          )}
        />
      </SettingGroup>
    </>
  );
}
