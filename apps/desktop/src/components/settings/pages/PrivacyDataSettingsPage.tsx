import { DevicesOtherOutlined } from "@mui/icons-material";
import type { ChangeEvent } from "react";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { produceAppState, useAppStore } from "../../../store";
import {
  setAutoLearnDictionaryEnabled,
  setAutoLearnFromEditsEnabled,
  setElevenLabsKeytermsEnabled,
  setIncognitoModeEnabled,
  setIncognitoModeIncludeInStats,
  setPreserveAudioOnFailure,
} from "../../../actions/user.actions";
import { logOnRejection } from "../../../utils/promise.utils";
import { getMyUserPreferences } from "../../../utils/user.utils";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { AudioTransmissionDisclosure } from "../AudioTransmissionDisclosure";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { useSettingsAvailability } from "../settings-availability";

const openDialog = (key: "multiDeviceDialogOpen") => {
  produceAppState((draft) => {
    draft.settings[key] = true;
  });
};

export default function PrivacyDataSettingsPage() {
  const availability = useSettingsAvailability();
  const [
    incognitoModeEnabled,
    incognitoIncludeInStats,
    preserveAudioOnFailure,
    elevenLabsKeytermsEnabled,
    autoLearnDictionaryEnabled,
    autoLearnFromEditsEnabled,
  ] = useAppStore((state) => {
    const preferences = getMyUserPreferences(state);
    return [
      preferences?.incognitoModeEnabled ?? false,
      preferences?.incognitoModeIncludeInStats ?? false,
      preferences?.preserveAudioOnFailure ?? true,
      preferences?.elevenLabsKeytermsEnabled ?? false,
      preferences?.autoLearnDictionaryEnabled ?? true,
      preferences?.autoLearnFromEditsEnabled ?? false,
    ] as const;
  });
  const [confirmSurcharge, setConfirmSurcharge] = useState(false);

  const toggle =
    (action: (enabled: boolean) => Promise<void> | void, label: string) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      logOnRejection(Promise.resolve(action(event.target.checked)), label);
    };

  const handleToggleElevenLabsKeyterms = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    // Turning this on adds a 20% ElevenLabs transcription surcharge, so the
    // opt-in only persists after the user acknowledges the cost.
    if (event.target.checked) {
      setConfirmSurcharge(true);
      return;
    }
    logOnRejection(
      setElevenLabsKeytermsEnabled(false),
      "settings page: setElevenLabsKeytermsEnabled",
    );
  };

  return (
    <>
      <SettingGroup
        title={<FormattedMessage defaultMessage="What leaves your device" />}
      >
        {availability.where_your_dictation_audio_goes && (
          <SettingRow
            settingKey="where_your_dictation_audio_goes"
            title={
              <FormattedMessage defaultMessage="Where your dictation audio goes" />
            }
            description={<AudioTransmissionDisclosure variant="setting" />}
          />
        )}
        {availability.elevenlabs_keyterms && (
          <SettingToggleRow
            settingKey="elevenlabs_keyterms"
            title={<FormattedMessage defaultMessage="ElevenLabs keyterms" />}
            description={
              <FormattedMessage defaultMessage="Sends your dictionary to ElevenLabs as keyterms for better name accuracy. Adds a 20% surcharge to every ElevenLabs transcription." />
            }
            checked={elevenLabsKeytermsEnabled}
            onChange={handleToggleElevenLabsKeyterms}
          />
        )}
      </SettingGroup>

      <SettingGroup
        title={<FormattedMessage defaultMessage="History and storage" />}
      >
        <SettingToggleRow
          settingKey="incognito_mode"
          title={<FormattedMessage defaultMessage="Incognito mode" />}
          description={
            <FormattedMessage defaultMessage="Stops mausVoice saving transcription history and audio snapshots." />
          }
          checked={incognitoModeEnabled}
          onChange={toggle(
            setIncognitoModeEnabled,
            "settings page: setIncognitoModeEnabled",
          )}
        />
        {availability.include_incognito_in_stats && (
          <SettingToggleRow
            settingKey="include_incognito_in_stats"
            title={
              <FormattedMessage defaultMessage="Include incognito in stats" />
            }
            description={
              <FormattedMessage defaultMessage="Count incognito dictation in streaks and word counts, without saving the text itself." />
            }
            checked={incognitoIncludeInStats}
            onChange={toggle(
              setIncognitoModeIncludeInStats,
              "settings page: setIncognitoModeIncludeInStats",
            )}
          />
        )}
        <SettingToggleRow
          settingKey="preserve_audio_on_failure"
          title={
            <FormattedMessage defaultMessage="Preserve audio on failure" />
          }
          description={
            <FormattedMessage defaultMessage="Keeps the audio of a failed transcription so you can replay it from History. Incognito recordings are never kept." />
          }
          checked={preserveAudioOnFailure}
          onChange={toggle(
            setPreserveAudioOnFailure,
            "settings page: setPreserveAudioOnFailure",
          )}
        />
      </SettingGroup>

      <SettingGroup
        title={<FormattedMessage defaultMessage="Dictionary learning" />}
      >
        <SettingToggleRow
          settingKey="auto_learn_dictionary"
          title={<FormattedMessage defaultMessage="Auto-learn dictionary" />}
          description={
            <FormattedMessage defaultMessage="Adds the names and words you correct to your dictionary automatically." />
          }
          checked={autoLearnDictionaryEnabled}
          onChange={toggle(
            setAutoLearnDictionaryEnabled,
            "settings page: setAutoLearnDictionaryEnabled",
          )}
        />
        {availability.learn_from_corrections && (
          <SettingToggleRow
            settingKey="learn_from_corrections"
            title={<FormattedMessage defaultMessage="Learn from corrections" />}
            description={
              <FormattedMessage defaultMessage="Watches for the edits you make after dictating, and offers to add the corrected names to your dictionary." />
            }
            checked={autoLearnFromEditsEnabled}
            onChange={toggle(
              setAutoLearnFromEditsEnabled,
              "settings page: setAutoLearnFromEditsEnabled",
            )}
          />
        )}
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Devices" />}>
        <SettingRow
          settingKey="multi_device"
          title={<FormattedMessage defaultMessage="Multi-device" />}
          description={
            <FormattedMessage defaultMessage="Pair and manage remote devices for dictation." />
          }
          icon={<DevicesOtherOutlined />}
          onClick={() => openDialog("multiDeviceDialogOpen")}
        />
      </SettingGroup>

      <ConfirmDialog
        isOpen={confirmSurcharge}
        title={
          <FormattedMessage defaultMessage="Enable ElevenLabs keyterms?" />
        }
        content={
          <FormattedMessage defaultMessage="Sending your dictionary as ElevenLabs keyterms adds a 20% surcharge to every ElevenLabs transcription. Only your non-empty dictionary is sent, and you can turn this off at any time." />
        }
        confirmLabel={
          <FormattedMessage defaultMessage="Enable with 20% surcharge" />
        }
        onCancel={() => setConfirmSurcharge(false)}
        onConfirm={() => {
          setConfirmSurcharge(false);
          logOnRejection(
            setElevenLabsKeytermsEnabled(true),
            "settings page: setElevenLabsKeytermsEnabled",
          );
        }}
      />
    </>
  );
}
