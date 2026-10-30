import { Button, CircularProgress, Stack, Typography } from "@mui/material";
import { getVersion } from "@tauri-apps/api/app";
import { useCallback } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { checkForAppUpdates } from "../../actions/updater.actions";
import { useAsyncData } from "../../hooks/async.hooks";
import { useAppStore } from "../../store";
import { SettingSection } from "../common/SettingSection";

const formatCheckedAt = (timestamp: number | null) => {
  if (timestamp == null) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
};

export const UpdateSettingSection = () => {
  const intl = useIntl();
  const status = useAppStore((state) => state.updater.status);
  const availableVersion = useAppStore(
    (state) => state.updater.availableVersion,
  );
  const lastCheckedAt = useAppStore((state) => state.updater.lastCheckedAt);
  const upToDateConfirmed = useAppStore(
    (state) => state.updater.upToDateConfirmed,
  );
  const errorMessage = useAppStore((state) => state.updater.errorMessage);
  const versionData = useAsyncData(getVersion, []);
  const installedVersion =
    versionData.state === "success" ? versionData.data : null;

  const isChecking = status === "checking";
  // The dialog owns the download/install flow; the button must not start a
  // second one underneath it.
  const isBusy =
    isChecking || status === "downloading" || status === "installing";

  const handleCheck = useCallback(() => {
    void checkForAppUpdates({ userInitiated: true });
  }, []);

  const versionLabel = installedVersion
    ? intl.formatMessage(
        { defaultMessage: "Version {version}" },
        { version: installedVersion },
      )
    : intl.formatMessage({ defaultMessage: "Version unavailable" });

  const checkedAtLabel = formatCheckedAt(lastCheckedAt);

  const statusMessage = (() => {
    if (isChecking) {
      return <FormattedMessage defaultMessage="Checking for updates…" />;
    }
    if (status === "error" && errorMessage) {
      return (
        <FormattedMessage defaultMessage="Could not check for updates. Check your connection and try again." />
      );
    }
    if (availableVersion) {
      return (
        <FormattedMessage
          defaultMessage="Version {version} is available."
          values={{ version: availableVersion }}
        />
      );
    }
    if (upToDateConfirmed) {
      return <FormattedMessage defaultMessage="You're up to date." />;
    }
    if (checkedAtLabel) {
      return (
        <FormattedMessage
          defaultMessage="Last checked {timestamp}."
          values={{ timestamp: checkedAtLabel }}
        />
      );
    }
    return <FormattedMessage defaultMessage="Not checked yet." />;
  })();

  return (
    <SettingSection
      title={<FormattedMessage defaultMessage="Software update" />}
      descriptionSlot={
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {versionLabel}
          </Typography>
          <Typography
            variant="body2"
            role="status"
            sx={{
              color: status === "error" ? "error.main" : "text.secondary",
            }}
          >
            {statusMessage}
          </Typography>
        </Stack>
      }
      action={
        <Button
          size="small"
          variant="outlined"
          onClick={handleCheck}
          disabled={isBusy}
          startIcon={
            isChecking ? <CircularProgress size={14} color="inherit" /> : null
          }
        >
          <FormattedMessage defaultMessage="Check now" />
        </Button>
      }
    />
  );
};
