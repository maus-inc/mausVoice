import {
  DeleteForeverOutlined,
  DeleteSweepOutlined,
  LogoutOutlined,
} from "@mui/icons-material";
import { FormattedMessage } from "react-intl";
import { signOut } from "../../../actions/login.actions";
import { useMyProfileImage } from "../../../hooks/user.hooks";
import type { AppState } from "../../../state/app.state";
import { produceAppState, useAppStore } from "../../../store";
import {
  getEffectivePlan,
  planToDisplayName,
} from "../../../utils/member.utils";
import { logOnRejection } from "../../../utils/promise.utils";
import { getMyUser } from "../../../utils/user.utils";
import { UserAvatar } from "../../common/UserAvatar";
import { SettingGroup, SettingRow } from "../SettingRow";
import { useSettingsAvailability } from "../settings-availability";

/**
 * The identity the account rows report: what the profile row shows for a name,
 * the address the account is signed in with, and the plan it is on.
 *
 * The three are read together because they are one subject, and the store
 * compares selector results deeply, so a fresh object per call is the intended
 * shape. The email is null in the local build, where there is no session.
 */
const selectAccountIdentity = (state: AppState) => ({
  name: getMyUser(state)?.name ?? "",
  email: state.auth?.email ?? null,
  planName: planToDisplayName(getEffectivePlan(state)),
});

const openDialog = (
  key:
    | "profileDialogOpen"
    | "changePasswordDialogOpen"
    | "deleteAccountDialog"
    | "clearLocalDataDialogOpen",
) => {
  produceAppState((draft) => {
    draft.settings[key] = true;
  });
};

export default function AccountSettingsPage() {
  const availability = useSettingsAvailability();
  const { name, email, planName } = useAppStore(selectAccountIdentity);
  const profileImage = useMyProfileImage();

  return (
    <>
      <SettingGroup title={<FormattedMessage defaultMessage="Profile" />}>
        {/* The identity row carries the picture as well as the name, so it gets
            the taller avatar and the verb the row actually performs. */}
        <SettingRow
          settingKey="name"
          icon={<UserAvatar name={name} src={profileImage} size={48} />}
          title={<FormattedMessage defaultMessage="Name" />}
          description={
            <FormattedMessage defaultMessage="How you appear in mausVoice, and the name it writes with on your behalf." />
          }
          value={name || null}
          action={{ label: <FormattedMessage defaultMessage="Edit" /> }}
          onClick={() => openDialog("profileDialogOpen")}
        />
        {availability.signed_in_as && (
          <SettingRow
            settingKey="signed_in_as"
            title={<FormattedMessage defaultMessage="Signed in as" />}
            description={
              <FormattedMessage defaultMessage="The account this copy of mausVoice is using." />
            }
            value={email}
          />
        )}
        <SettingRow
          settingKey="plan"
          title={<FormattedMessage defaultMessage="Plan" />}
          description={
            <FormattedMessage defaultMessage="What your current plan includes. Change it from the mausVoice website." />
          }
          value={planName}
        />
      </SettingGroup>

      <SettingGroup title={<FormattedMessage defaultMessage="Security" />}>
        {availability.change_password && (
          <SettingRow
            settingKey="change_password"
            title={<FormattedMessage defaultMessage="Change password" />}
            description={
              <FormattedMessage
                defaultMessage="Sends a password reset link to {email}."
                values={{ email: email ?? "" }}
              />
            }
            onClick={() => openDialog("changePasswordDialogOpen")}
          />
        )}
        {availability.sign_out && (
          <SettingRow
            settingKey="sign_out"
            title={<FormattedMessage defaultMessage="Sign out" />}
            description={
              <FormattedMessage defaultMessage="Ends this session on this computer. Your data stays where it is." />
            }
            icon={<LogoutOutlined />}
            onClick={() => {
              logOnRejection(signOut(), "settings page: signOut");
            }}
          />
        )}
      </SettingGroup>

      <SettingGroup
        title={<FormattedMessage defaultMessage="Danger zone" />}
        danger
      >
        {/* Clearing local data lives here rather than under Privacy and data
            because it is the account-and-device section: it is the same kind of
            decision as deleting the account, and it sits next to it so the two
            can be compared before either is chosen. */}
        <SettingRow
          settingKey="clear_local_data"
          title={<FormattedMessage defaultMessage="Clear local data" />}
          description={
            <FormattedMessage defaultMessage="Removes stored history, audio snapshots, your photo, and settings from this computer. This cannot be undone." />
          }
          icon={<DeleteSweepOutlined color="error" />}
          action={{
            label: <FormattedMessage defaultMessage="Clear data" />,
            tone: "error",
          }}
          onClick={() => openDialog("clearLocalDataDialogOpen")}
        />
        {availability.delete_account && (
          <SettingRow
            settingKey="delete_account"
            title={<FormattedMessage defaultMessage="Delete account" />}
            description={
              <FormattedMessage defaultMessage="Deletes your account and everything stored with it. This cannot be undone." />
            }
            icon={<DeleteForeverOutlined color="error" />}
            action={{
              label: <FormattedMessage defaultMessage="Delete" />,
              tone: "error",
            }}
            onClick={() => openDialog("deleteAccountDialog")}
          />
        )}
      </SettingGroup>
    </>
  );
}
