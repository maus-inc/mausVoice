import type { UpdateChannel } from "@maus-inc/types";
import { FormattedMessage, useIntl } from "react-intl";
import { useState } from "react";
import { setUpdateChannel } from "../../actions/user.actions";
import { useAppStore } from "../../store";
import { getMyUserPreferences } from "../../utils/user.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { SegmentedControl } from "../common/SegmentedControl";
import { SettingSection } from "../common/SettingSection";

export const UpdateChannelSetting = () => {
  const intl = useIntl();
  const channel = useAppStore(
    (state) => getMyUserPreferences(state)?.updateChannel ?? "stable",
  );
  const [pendingBeta, setPendingBeta] = useState(false);

  const handleChange = (next: UpdateChannel) => {
    if (next === "beta") {
      setPendingBeta(true);
      return;
    }
    void setUpdateChannel(next);
  };

  const handleConfirmBeta = () => {
    setPendingBeta(false);
    void setUpdateChannel("beta");
  };

  return (
    <>
      <SettingSection
        title={
          <FormattedMessage
            id="settings.updateChannel.title"
            defaultMessage="Update channel"
          />
        }
        description={
          <FormattedMessage
            id="settings.updateChannel.description"
            defaultMessage="Stable ships tested releases. Beta offers prereleases early and may wait for a newer stable before switching back."
          />
        }
        action={
          <SegmentedControl<UpdateChannel>
            value={channel}
            onChange={handleChange}
            options={[
              {
                value: "stable",
                label: intl.formatMessage({
                  id: "settings.updateChannel.stable",
                  defaultMessage: "Stable",
                }),
              },
              {
                value: "beta",
                label: intl.formatMessage({
                  id: "settings.updateChannel.beta",
                  defaultMessage: "Beta",
                }),
              },
            ]}
            ariaLabel={intl.formatMessage({
              id: "settings.updateChannel.ariaLabel",
              defaultMessage: "Update channel",
            })}
          />
        }
      />

      <ConfirmDialog
        isOpen={pendingBeta}
        title={
          <FormattedMessage
            id="settings.updateChannel.confirmTitle"
            defaultMessage="Join the beta channel?"
          />
        }
        content={
          <FormattedMessage
            id="settings.updateChannel.confirmContent"
            defaultMessage="Beta builds arrive earlier but may carry rough edges. Returning to stable can wait until a newer stable release passes your beta version."
          />
        }
        onCancel={() => setPendingBeta(false)}
        onConfirm={handleConfirmBeta}
        confirmLabel={
          <FormattedMessage
            id="settings.updateChannel.confirmLabel"
            defaultMessage="Join beta"
          />
        }
      />
    </>
  );
};
