import {
  DescriptionOutlined,
  KeyboardAltOutlined,
  TroubleshootOutlined,
} from "@mui/icons-material";
import type { ChangeEvent } from "react";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import {
  commands,
  type NativeSetupResult,
} from "@maus-inc/desktop-native-apis";
import { showErrorSnackbar, showSnackbar } from "../../../actions/app.actions";
import { setAutoLaunchEnabled } from "../../../actions/settings.actions";
import {
  setAlwaysRequestAdminOnStartup,
  setIgnoreUpdateDialog,
} from "../../../actions/user.actions";
import { produceAppState, useAppStore } from "../../../store";
import { getPlatform } from "../../../utils/platform.utils";
import { logOnRejection } from "../../../utils/promise.utils";
import { getMyUserPreferences } from "../../../utils/user.utils";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { SettingGroup, SettingRow, SettingToggleRow } from "../SettingRow";
import { UpdateChannelSetting } from "../UpdateChannelSetting";
import { UpdateSettingSection } from "../UpdateSettingSection";
import { useSettingsAvailability } from "../settings-availability";

const LICENCE_URL = "https://github.com/maus-inc/mausVoice/blob/main/LICENCE";

export default function SystemSettingsPage() {
  const availability = useSettingsAvailability();
  const platform = getPlatform();
  const [autoLaunchEnabled, autoLaunchStatus] = useAppStore((state) => [
    state.settings.autoLaunchEnabled,
    state.settings.autoLaunchStatus,
  ]);
  const [ignoreUpdateDialog, alwaysRequestAdmin] = useAppStore((state) => [
    getMyUserPreferences(state)?.ignoreUpdateDialog ?? false,
    state.userPrefs?.alwaysRequestAdminOnStartup ?? false,
  ]);

  const [setupConfirmOpen, setSetupConfirmOpen] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);

  const inputPermissionsDescription = (() => {
    switch (platform) {
      case "linux":
        return (
          <FormattedMessage defaultMessage="Configures global input capture (uinput/udev) so the pill can type for you. Requires administrator privileges." />
        );
      case "windows":
        return (
          <FormattedMessage defaultMessage="Grants administrator privileges and input-capture access so the pill can type for you. You will see a User Account Control prompt." />
        );
      case "macos":
        return (
          <FormattedMessage defaultMessage="Requests Accessibility and Microphone access so the pill can type for you. You will be prompted in System Settings." />
        );
      default:
        return null;
    }
  })();

  const setupConfirmContent = (() => {
    switch (platform) {
      case "linux":
        return (
          <FormattedMessage defaultMessage="This requires administrator privileges to configure global input capture (uinput/udev). Continue?" />
        );
      case "windows":
        return (
          <FormattedMessage defaultMessage="This will prompt for administrator privileges (UAC) so the pill can capture and type input globally. Continue?" />
        );
      default:
        return (
          <FormattedMessage defaultMessage="This will request Accessibility and Microphone access so the pill can capture and type input globally. Continue?" />
        );
    }
  })();

  const runNativeSetup = async () => {
    setSetupConfirmOpen(false);
    setSetupRunning(true);
    try {
      const result: NativeSetupResult = await commands.runNativeSetup();
      if (result === "success") {
        showSnackbar("Input permissions configured.");
      } else if (result === "require-restart") {
        showSnackbar(
          "Setup complete. Please restart the app to apply input permissions.",
        );
      } else if (result === "cancelled") {
        // User dismissed the elevation prompt; stay quiet.
      } else {
        showErrorSnackbar("Failed to configure input permissions.");
      }
    } catch (error) {
      showErrorSnackbar(error);
    } finally {
      setSetupRunning(false);
    }
  };

  const handleToggleAutoLaunch = (event: ChangeEvent<HTMLInputElement>) => {
    void setAutoLaunchEnabled(event.target.checked);
  };

  const handleToggleShowUpdates = (event: ChangeEvent<HTMLInputElement>) => {
    logOnRejection(
      setIgnoreUpdateDialog(!event.target.checked),
      "settings page: setIgnoreUpdateDialog",
    );
  };

  const handleToggleAlwaysRequestAdmin = (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    // `logOnRejection`, not a bare `void`: the write shows its own error
    // snackbar and then rethrows, so the rejection has to be handled here.
    logOnRejection(
      setAlwaysRequestAdminOnStartup(event.target.checked),
      "settings page: setAlwaysRequestAdminOnStartup",
    );
  };

  return (
    <>
      <SettingGroup title={<FormattedMessage defaultMessage="Startup" />}>
        <SettingToggleRow
          settingKey="start_on_system_startup"
          title={<FormattedMessage defaultMessage="Start on system startup" />}
          description={
            <FormattedMessage defaultMessage="Launches mausVoice when you sign in, so dictation is ready before you are." />
          }
          checked={autoLaunchEnabled}
          disabled={autoLaunchStatus === "loading"}
          onChange={handleToggleAutoLaunch}
        />
        {availability.always_run_as_administrator && (
          <SettingToggleRow
            settingKey="always_run_as_administrator"
            title={
              <FormattedMessage defaultMessage="Always run as administrator" />
            }
            description={
              <FormattedMessage defaultMessage="Asks for administrator permission every time mausVoice starts, instead of configuring input permissions manually. Takes effect on the next launch." />
            }
            checked={alwaysRequestAdmin}
            onChange={handleToggleAlwaysRequestAdmin}
          />
        )}
      </SettingGroup>

      <SettingGroup
        title={<FormattedMessage defaultMessage="Input permissions" />}
        description={inputPermissionsDescription}
      >
        <SettingRow
          settingKey="configure_input_permissions"
          title={
            <FormattedMessage defaultMessage="Configure input permissions" />
          }
          description={
            <FormattedMessage defaultMessage="Runs the setup that lets the pill capture your keys and type for you." />
          }
          icon={<KeyboardAltOutlined />}
          disabled={setupRunning}
          onClick={() => setSetupConfirmOpen(true)}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Updates" />}>
        <UpdateSettingSection />
        <SettingToggleRow
          settingKey="automatically_show_updates"
          title={
            <FormattedMessage defaultMessage="Automatically show updates" />
          }
          description={
            <FormattedMessage defaultMessage="Opens the update window by itself when a new version is available." />
          }
          checked={!ignoreUpdateDialog}
          onChange={handleToggleShowUpdates}
        />
        <UpdateChannelSetting />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Support" />}>
        <SettingRow
          settingKey="diagnostics"
          title={<FormattedMessage defaultMessage="Diagnostics" />}
          description={
            <FormattedMessage defaultMessage="Version, platform paths, and a support bundle you can send us." />
          }
          icon={<TroubleshootOutlined />}
          onClick={() =>
            produceAppState((draft) => {
              draft.settings.diagnosticsDialogOpen = true;
            })
          }
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Legal" />}>
        <SettingRow
          settingKey="terms_conditions"
          title={<FormattedMessage defaultMessage="Terms & conditions" />}
          description={
            <FormattedMessage defaultMessage="The licence this copy of mausVoice ships under." />
          }
          icon={<DescriptionOutlined />}
          externalUrl={LICENCE_URL}
        />
      </SettingGroup>

      <ConfirmDialog
        isOpen={setupConfirmOpen}
        title={
          <FormattedMessage defaultMessage="Configure input permissions" />
        }
        content={setupConfirmContent}
        confirmLabel={<FormattedMessage defaultMessage="Continue" />}
        onCancel={() => setSetupConfirmOpen(false)}
        onConfirm={runNativeSetup}
      />
    </>
  );
}
