import type { UpdateChannel } from "@maus-inc/types";
import { FormattedMessage, useIntl } from "react-intl";
import { useRef, useState } from "react";
import { setUpdateChannel } from "../../actions/user.actions";
import { useAppStore } from "../../store";
import { getMyUserPreferences } from "../../utils/user.utils";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { SegmentedControl } from "../common/SegmentedControl";
import { SettingSection } from "../common/SettingSection";
import { TipCard } from "../onboarding/TipCard";

export const UpdateChannelSetting = () => {
  const intl = useIntl();
  const channel = useAppStore(
    (state) => getMyUserPreferences(state)?.updateChannel ?? "stable",
  );
  const [pendingBeta, setPendingBeta] = useState(false);

  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const installing = useAppStore(
    (state) =>
      state.updater.status === "downloading" ||
      state.updater.status === "installing",
  );
  const disabled = changing || installing;
  const applyChannel = async (next: UpdateChannel) => {
    if (changingRef.current || installing) return;
    changingRef.current = true;
    setChanging(true);
    try {
      await setUpdateChannel(next);
    } catch {
      // The preference action already displayed its localized storage error.
    } finally {
      changingRef.current = false;
      setChanging(false);
    }
  };

  const handleChange = (next: UpdateChannel) => {
    if (disabled) return;
    if (next === "beta") {
      setPendingBeta(true);
      return;
    }
    void applyChannel(next);
  };

  const handleConfirmBeta = () => {
    setPendingBeta(false);
    void applyChannel("beta");
  };

  return (
    <>
      {/* The tip is anchored here rather than only in Help, so a user reaches it
          where they actually make the choice. Without a contextual anchor the
          `update-channel` tip was listed in Help and nowhere else, so the only
          way to discover it was to go looking for it. */}
      <TipCard id="update-channel" />
      <SettingSection
        title={<FormattedMessage defaultMessage="Update channel" />}
        description={
          <FormattedMessage defaultMessage="Stable ships tested releases. Beta offers prereleases early and may wait for a newer stable before switching back." />
        }
        action={
          <SegmentedControl<UpdateChannel>
            value={channel}
            onChange={handleChange}
            // Only the option the user is not on is disabled while a change or
            // an install is in flight. Disabling both left `SegmentedControl`
            // with no enabled option, and it falls back to the first tab, so a
            // beta user watched the control jump to "Stable" for the duration
            // of a download. `handleChange` still refuses the change, so the
            // persisted option stays selectable and the state cannot move.
            options={[
              {
                value: "stable",
                disabled: disabled && channel !== "stable",
                label: intl.formatMessage({
                  defaultMessage: "Stable",
                }),
              },
              {
                value: "beta",
                disabled: disabled && channel !== "beta",
                label: intl.formatMessage({
                  defaultMessage: "Beta",
                }),
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
        busy={disabled}
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
