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
        title={<FormattedMessage defaultMessage="Update channel" />}
        description={
          <FormattedMessage defaultMessage="Stable ships tested releases. Beta offers prereleases early and may wait for a newer stable before switching back." />
        }
        action={
          <SegmentedControl<UpdateChannel>
            value={channel}
            onChange={handleChange}
            options={[
              {
                value: "stable",
                label: intl.formatMessage({ defaultMessage: "Stable" }),
              },
              {
                value: "beta",
                label: intl.formatMessage({ defaultMessage: "Beta" }),
              },
            ]}
            ariaLabel={intl.formatMessage({
              defaultMessage: "Update channel",
            })}
          />
        }
      />

      <ConfirmDialog
        isOpen={pendingBeta}
        title={<FormattedMessage defaultMessage="Join the beta channel?" />}
        content={
          <FormattedMessage defaultMessage="Beta builds arrive earlier but may carry rough edges. Returning to stable can wait until a newer stable release passes your beta version." />
        }
        onCancel={() => setPendingBeta(false)}
        onConfirm={handleConfirmBeta}
        confirmLabel={<FormattedMessage defaultMessage="Join beta" />}
      />
    </>
  );
};
