import { ArrowUpwardOutlined } from "@mui/icons-material";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isReadOnlyFilesystemInstallError } from "@maus-inc/desktop-utils";
import { useCallback, useMemo } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import Markdown from "react-markdown";
import {
  dismissUpdateDialog,
  installAvailableUpdate,
} from "../../actions/updater.actions";
import { UpdaterStatus } from "../../state/updater.state";
import { useAppStore } from "../../store";
import { formatSize } from "../../utils/format.utils";

const formatReleaseDate = (isoDate: string | null) => {
  if (!isoDate) {
    return null;
  }

  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
};

const getUpdaterUiState = ({
  status,
  requiresManualInstall,
  errorMessage,
  manualInstallerUrl,
}: {
  status: UpdaterStatus;
  requiresManualInstall: boolean;
  errorMessage: string | null;
  manualInstallerUrl: string | null;
}) => {
  const pkgInstallerOpened = requiresManualInstall && status === "installing";
  const isUpdating =
    (status === "downloading" || status === "installing") &&
    !pkgInstallerOpened;
  const showProgress = status === "downloading" || status === "installing";
  const showManualInstallerAction =
    status === "error" &&
    isReadOnlyFilesystemInstallError(errorMessage) &&
    Boolean(manualInstallerUrl);

  return {
    pkgInstallerOpened,
    isUpdating,
    showProgress,
    showManualInstallerAction,
  };
};

const getDownloadPercent = (
  downloadProgress: number | null | undefined,
): number | null => {
  if (downloadProgress == null) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, downloadProgress));
  return Math.round(clamped * 100);
};

const getProgressLabel = (
  downloadedBytes: number | null | undefined,
  totalBytes: number | null | undefined,
  intl: IntlShape,
): string | null => {
  if (downloadedBytes == null || totalBytes == null || totalBytes <= 0) {
    return null;
  }
  return intl.formatMessage(
    {
      defaultMessage: "{downloaded} of {total}",
    },
    {
      downloaded: formatSize(downloadedBytes),
      total: formatSize(totalBytes),
    },
  );
};

const UpdateProgress = ({
  status,
  requiresManualInstall,
  percent,
  progressLabel,
}: {
  status: UpdaterStatus;
  requiresManualInstall: boolean;
  percent: number | null;
  progressLabel: string | null;
}) => {
  return (
    <Stack spacing={1}>
      <LinearProgress
        variant={percent != null ? "determinate" : "indeterminate"}
        value={percent ?? undefined}
      />
      <Stack
        direction="row"
        spacing={1}
        sx={{
          justifyContent: "space-between",
        }}
      >
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {status === "installing" ? (
            requiresManualInstall ? (
              <FormattedMessage defaultMessage="Opening installer..." />
            ) : (
              <FormattedMessage defaultMessage="Installing update..." />
            )
          ) : (
            <FormattedMessage defaultMessage="Downloading update..." />
          )}
        </Typography>
        {progressLabel && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {progressLabel}
            {percent != null ? ` (${percent}%)` : ""}
          </Typography>
        )}
      </Stack>
    </Stack>
  );
};

const UpdateStatusAlerts = ({
  status,
  requiresManualInstall,
  errorMessage,
  showManualInstallerAction,
  onOpenManualInstaller,
}: {
  status: UpdaterStatus;
  requiresManualInstall: boolean;
  errorMessage: string | null;
  showManualInstallerAction: boolean;
  onOpenManualInstaller: () => void;
}) => {
  if (status === "installing") {
    return requiresManualInstall ? (
      <Alert severity="success" variant="outlined">
        <FormattedMessage defaultMessage="The installer has been opened. Follow the prompts to complete the update, then relaunch mausVoice." />
      </Alert>
    ) : (
      <Alert severity="info" variant="outlined">
        <FormattedMessage defaultMessage="Installation in progress. mausVoice may restart automatically when finished." />
      </Alert>
    );
  }

  if (status === "error" && errorMessage) {
    return (
      <Alert
        severity="error"
        variant="outlined"
        action={
          showManualInstallerAction ? (
            <Button color="error" size="small" onClick={onOpenManualInstaller}>
              <FormattedMessage defaultMessage="Download installer" />
            </Button>
          ) : undefined
        }
      >
        <Stack spacing={1}>
          <Typography variant="body2">{errorMessage}</Typography>
          {showManualInstallerAction && (
            <Typography variant="body2">
              <FormattedMessage defaultMessage="Your operating system is preventing mausVoice from modifying files in its current install location. Use the download button to get the latest installer, then run it to complete the update manually." />
            </Typography>
          )}
        </Stack>
      </Alert>
    );
  }

  return null;
};

const UpdateDialogActions = ({
  pkgInstallerOpened,
  isUpdating,
  onClose,
  onInstall,
}: {
  pkgInstallerOpened: boolean;
  isUpdating: boolean;
  onClose: () => void;
  onInstall: () => void;
}) => {
  if (pkgInstallerOpened) {
    return (
      <Button onClick={onClose}>
        <FormattedMessage defaultMessage="Close" />
      </Button>
    );
  }

  return (
    <>
      <Button onClick={onClose} disabled={isUpdating}>
        <FormattedMessage defaultMessage="Later" />
      </Button>
      <Button
        variant="contained"
        onClick={onInstall}
        disabled={isUpdating}
        endIcon={
          isUpdating ? (
            <CircularProgress size={16} color="inherit" />
          ) : (
            <ArrowUpwardOutlined />
          )
        }
      >
        <FormattedMessage defaultMessage="Update" />
      </Button>
    </>
  );
};

export const UpdateDialog = () => {
  const intl = useIntl();
  const dialogOpen = useAppStore((state) => state.updater.dialogOpen);
  const status = useAppStore((state) => state.updater.status);
  const availableVersion = useAppStore(
    (state) => state.updater.availableVersion,
  );
  const currentVersion = useAppStore((state) => state.updater.currentVersion);
  const releaseDate = useAppStore((state) => state.updater.releaseDate);
  const releaseNotes = useAppStore((state) => state.updater.releaseNotes);
  const manualInstallerUrl = useAppStore(
    (state) => state.updater.manualInstallerUrl,
  );
  const downloadProgress = useAppStore(
    (state) => state.updater.downloadProgress,
  );
  const downloadedBytes = useAppStore((state) => state.updater.downloadedBytes);
  const totalBytes = useAppStore((state) => state.updater.totalBytes);
  const errorMessage = useAppStore((state) => state.updater.errorMessage);
  const requiresManualInstall = useAppStore(
    (state) => state.updater.requiresManualInstall,
  );

  const ui = getUpdaterUiState({
    status,
    requiresManualInstall,
    errorMessage,
    manualInstallerUrl,
  });

  const versionLabel = availableVersion
    ? intl.formatMessage(
        {
          defaultMessage: "mausVoice {version}",
        },
        { version: availableVersion },
      )
    : intl.formatMessage({
        defaultMessage: "A mausVoice update",
      });

  const formattedDate = useMemo(
    () => formatReleaseDate(releaseDate),
    [releaseDate],
  );

  const percent = useMemo(
    () => getDownloadPercent(downloadProgress),
    [downloadProgress],
  );
  const progressLabel = useMemo(
    () => getProgressLabel(downloadedBytes, totalBytes, intl),
    [downloadedBytes, totalBytes, intl],
  );

  const currentVersionLabel =
    currentVersion ??
    intl.formatMessage({
      defaultMessage: "unknown",
    });

  const readyToInstallLabel = intl.formatMessage(
    {
      defaultMessage: "{label} is ready to install.",
    },
    { label: versionLabel },
  );

  const currentVersionDescription = intl.formatMessage(
    {
      defaultMessage:
        "You're currently on version {version}. The app will restart after the update finishes.",
    },
    { version: currentVersionLabel },
  );

  const handleClose = useCallback(() => {
    if (ui.isUpdating) {
      return;
    }
    dismissUpdateDialog();
  }, [ui.isUpdating]);

  const handleInstall = useCallback(async () => {
    if (ui.isUpdating) {
      return;
    }
    await installAvailableUpdate();
  }, [ui.isUpdating]);

  const handleOpenManualInstaller = useCallback(() => {
    if (!manualInstallerUrl) {
      return;
    }
    openUrl(manualInstallerUrl);
  }, [manualInstallerUrl]);

  return (
    <Dialog
      open={dialogOpen}
      onClose={(_, __) => {
        if (!ui.isUpdating) {
          handleClose();
        }
      }}
      fullWidth
      maxWidth="sm"
      sx={{ zIndex: 9999 }}
    >
      <DialogTitle>
        <FormattedMessage defaultMessage="Update available" />
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack spacing={0.5}>
            <Typography
              variant="body1"
              sx={{
                fontWeight: 600,
              }}
            >
              {readyToInstallLabel}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {currentVersionDescription}
            </Typography>
            {formattedDate && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                <FormattedMessage
                  defaultMessage="Released on {date}"
                  values={{ date: formattedDate }}
                />
              </Typography>
            )}
          </Stack>

          {releaseNotes && (
            <Stack spacing={1}>
              <Typography variant="body1">
                <FormattedMessage defaultMessage="What's new" />
              </Typography>
              <Markdown>{releaseNotes}</Markdown>
            </Stack>
          )}

          {ui.showProgress && (
            <UpdateProgress
              status={status}
              requiresManualInstall={requiresManualInstall}
              percent={percent}
              progressLabel={progressLabel}
            />
          )}

          <UpdateStatusAlerts
            status={status}
            requiresManualInstall={requiresManualInstall}
            errorMessage={errorMessage}
            showManualInstallerAction={ui.showManualInstallerAction}
            onOpenManualInstaller={handleOpenManualInstaller}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <UpdateDialogActions
          pkgInstallerOpened={ui.pkgInstallerOpened}
          isUpdating={ui.isUpdating}
          onClose={handleClose}
          onInstall={() => void handleInstall()}
        />
      </DialogActions>
    </Dialog>
  );
};
