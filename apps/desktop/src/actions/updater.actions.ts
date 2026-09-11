import {
  checkForUpdate,
  closeAvailableUpdate,
  downloadAndOpenMacInstaller,
  hasAvailableUpdate,
  installAvailableUpdate as pkgInstallAvailableUpdate,
  isReadOnlyFilesystemInstallError,
  relaunchApp,
} from "@maus-inc/desktop-utils";
import { invoke } from "@tauri-apps/api/core";
import { getIntl } from "../i18n/intl";
import { getAppState, produceAppState } from "../store";
import { getPlatform } from "../utils/env.utils";
import { daysToMilliseconds } from "../utils/time.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import { markSurfaceWindowForNextLaunch } from "../utils/window.utils";
import { showErrorSnackbar } from "./app.actions";
import { showToast } from "./toast.actions";

let checkingPromise: Promise<boolean> | null = null;
// Coalesces user-initiated intent across concurrent callers: a manual check
// that joins an in-flight background check must still open the dialog and
// report its result, rather than being treated as another background check.
let checkingUserInitiated = false;
let installingPromise: Promise<void> | null = null;

/**
 * Keeps the tray badge in step with the check result. Owned by the action
 * rather than the caller so a manual check updates the badge too, instead of
 * leaving it stale until the next background poll.
 */
const syncMenuIcon = (updateAvailable: boolean): void => {
  invoke("set_menu_icon", {
    variant: updateAvailable ? "update" : "default",
  }).catch((error: unknown) => {
    console.error("Failed to update the tray icon", error);
  });
};

const isBusy = () => {
  const { status } = getAppState().updater;
  return status === "downloading" || status === "installing";
};

/**
 * Checks the updater endpoint. Pass `{ userInitiated: true }` for a check the
 * user asked for: it reports an explicit "up to date" result and bypasses the
 * dismissal window, so the dialog opens even inside a snooze.
 */
export const checkForAppUpdates = async (
  options: { userInitiated?: boolean } = {},
): Promise<boolean> => {
  const { userInitiated = false } = options;

  if (isBusy()) {
    return false;
  }

  if (checkingPromise) {
    // Accumulate manual intent so a user click that joins an in-flight
    // background check still opens the dialog and reports the result.
    checkingUserInitiated = checkingUserInitiated || userInitiated;
    return checkingPromise;
  }

  checkingUserInitiated = userInitiated;
  const platform = getPlatform();

  const run = async (): Promise<boolean> => {
    produceAppState((draft) => {
      draft.updater.status = "checking";
      draft.updater.errorMessage = null;
      draft.updater.manualInstallerUrl = null;
      draft.updater.manualInstallerSignatureUrl = null;
      draft.updater.downloadProgress = null;
      draft.updater.downloadedBytes = null;
      draft.updater.totalBytes = null;
      draft.updater.upToDateConfirmed = false;
    });

    let update: Awaited<ReturnType<typeof checkForUpdate>>;
    try {
      update = await checkForUpdate(platform);
    } catch (error) {
      console.error("Failed to check for updates", error);
      produceAppState((draft) => {
        draft.updater.status = "error";
        draft.updater.errorMessage = String(error);
        draft.updater.manualInstallerUrl = null;
        draft.updater.manualInstallerSignatureUrl = null;
        draft.updater.lastCheckedAt = Date.now();
      });
      return false;
    }

    if (!update) {
      produceAppState((draft) => {
        draft.updater.status = "idle";
        draft.updater.dialogOpen = false;
        draft.updater.availableVersion = null;
        draft.updater.currentVersion = null;
        draft.updater.releaseDate = null;
        draft.updater.releaseNotes = null;
        draft.updater.manualInstallerUrl = null;
        draft.updater.manualInstallerSignatureUrl = null;
        draft.updater.requiresManualInstall = false;
        draft.updater.errorMessage = null;
        draft.updater.downloadProgress = null;
        draft.updater.downloadedBytes = null;
        draft.updater.totalBytes = null;
        draft.updater.lastCheckedAt = Date.now();
        draft.updater.upToDateConfirmed = checkingUserInitiated;
      });
      syncMenuIcon(false);
      return false;
    }

    const state = getAppState();
    const { dialogOpen, dismissedUntil } = state.updater;
    const ignoreUpdateDialog =
      getMyUserPreferences(state)?.ignoreUpdateDialog ?? false;
    // A user-initiated check is itself the request to see the dialog, so it
    // ignores both the snooze window and the auto-show preference.
    const shouldAutoShowDialog =
      !dialogOpen &&
      (checkingUserInitiated ||
        (!ignoreUpdateDialog &&
          (!dismissedUntil || Date.now() >= dismissedUntil)));

    produceAppState((draft) => {
      draft.updater.status = "ready";
      draft.updater.currentVersion = update.currentVersion;
      draft.updater.availableVersion = update.version;
      draft.updater.releaseDate = update.releaseDate;
      draft.updater.releaseNotes = update.releaseNotes;
      draft.updater.manualInstallerUrl = update.manualInstallerUrl;
      draft.updater.manualInstallerSignatureUrl =
        update.manualInstallerSignatureUrl;
      draft.updater.requiresManualInstall = update.requiresManualInstall;
      draft.updater.errorMessage = null;
      draft.updater.downloadProgress = null;
      draft.updater.downloadedBytes = null;
      draft.updater.totalBytes = null;
      draft.updater.lastCheckedAt = Date.now();
      draft.updater.upToDateConfirmed = false;
      if (shouldAutoShowDialog) {
        draft.updater.dialogOpen = true;
      }
    });

    syncMenuIcon(true);

    // It's hard to see the update menu icon on Windows, so show a
    // toast notification when an update is available. On macOS, the menu icon
    // is more visible and users are more accustomed to checking there for
    // updates, so we can skip the toast.
    if (
      shouldAutoShowDialog &&
      !checkingUserInitiated &&
      platform !== "darwin"
    ) {
      const intl = getIntl();
      await showToast({
        message: intl.formatMessage(
          {
            defaultMessage: "Version {version} is ready to install",
          },
          { version: update.version },
        ),
        toastType: "info",
        action: "surface_window",
        duration: 8_000,
      });
    }

    return true;
  };

  checkingPromise = run();

  try {
    return await checkingPromise;
  } finally {
    checkingPromise = null;
    checkingUserInitiated = false;
  }
};

export const openUpdateDialog = async (): Promise<void> => {
  if (hasAvailableUpdate()) {
    produceAppState((draft) => {
      draft.updater.dialogOpen = true;
      draft.updater.errorMessage = null;
    });
    return;
  }

  await checkForAppUpdates({ userInitiated: true });
};

const THREE_DAYS_MS = daysToMilliseconds(3);

export const dismissUpdateDialog = (duration = THREE_DAYS_MS): void => {
  produceAppState((draft) => {
    draft.updater.dialogOpen = false;
    draft.updater.dismissedUntil = Date.now() + duration;
  });
};

const installViaPkgInstaller = async (): Promise<boolean> => {
  const { manualInstallerUrl, manualInstallerSignatureUrl } =
    getAppState().updater;
  if (!manualInstallerUrl || !manualInstallerSignatureUrl) {
    showErrorSnackbar("No installer package available for this version.");
    return false;
  }

  produceAppState((draft) => {
    draft.updater.status = "downloading";
    draft.updater.errorMessage = null;
    draft.updater.dialogOpen = true;
    draft.updater.downloadProgress = null;
    draft.updater.downloadedBytes = null;
    draft.updater.totalBytes = null;
  });

  try {
    await downloadAndOpenMacInstaller(
      manualInstallerUrl,
      manualInstallerSignatureUrl,
    );
  } catch (error) {
    console.error("Failed to download or open pkg installer", error);
    produceAppState((draft) => {
      draft.updater.status = "error";
      draft.updater.errorMessage = String(error);
      draft.updater.dialogOpen = true;
      draft.updater.downloadProgress = null;
      draft.updater.downloadedBytes = null;
      draft.updater.totalBytes = null;
    });
    showErrorSnackbar("Failed to download the installer. Please try again.");
    return false;
  }

  produceAppState((draft) => {
    draft.updater.status = "installing";
  });

  return true;
};

const installViaBuiltInUpdater = async (): Promise<boolean> => {
  produceAppState((draft) => {
    draft.updater.status = "downloading";
    draft.updater.errorMessage = null;
    draft.updater.dialogOpen = true;
    draft.updater.downloadProgress = null;
    draft.updater.downloadedBytes = 0;
    draft.updater.totalBytes = null;
  });

  try {
    await pkgInstallAvailableUpdate({
      onDownloadStarted: (totalBytes) => {
        produceAppState((draft) => {
          draft.updater.status = "downloading";
          draft.updater.totalBytes = totalBytes;
          draft.updater.downloadedBytes = 0;
          draft.updater.downloadProgress =
            totalBytes && totalBytes > 0 ? 0 : null;
        });
      },
      onDownloadProgress: (downloadedBytes, totalBytes) => {
        const progress =
          totalBytes != null && totalBytes > 0
            ? Math.max(0, Math.min(1, downloadedBytes / totalBytes))
            : null;
        produceAppState((draft) => {
          draft.updater.downloadedBytes = downloadedBytes;
          draft.updater.downloadProgress = progress;
        });
      },
      onInstalling: () => {
        produceAppState((draft) => {
          draft.updater.status = "installing";
          const { totalBytes, downloadedBytes, downloadProgress } =
            draft.updater;
          draft.updater.downloadedBytes = totalBytes ?? downloadedBytes;
          draft.updater.downloadProgress =
            totalBytes != null ? 1 : downloadProgress;
        });
      },
    });
  } catch (error) {
    const errorMessage = String(error);
    const platform = getPlatform();
    const shouldUseManualInstaller =
      platform === "darwin" && isReadOnlyFilesystemInstallError(errorMessage);
    console.error("Failed to download or install update", error);

    if (shouldUseManualInstaller) {
      produceAppState((draft) => {
        draft.updater.requiresManualInstall = true;
      });
      return installViaPkgInstaller();
    }

    produceAppState((draft) => {
      draft.updater.status = "error";
      draft.updater.errorMessage = errorMessage;
      draft.updater.dialogOpen = true;
      draft.updater.downloadProgress = null;
      draft.updater.downloadedBytes = null;
      draft.updater.totalBytes = null;
    });
    showErrorSnackbar("Failed to install update. Please try again.");
    return false;
  }

  produceAppState((draft) => {
    draft.updater.status = "installing";
  });

  return true;
};

export const installAvailableUpdate = async (): Promise<void> => {
  if (installingPromise) {
    return installingPromise;
  }

  if (!hasAvailableUpdate()) {
    return;
  }

  const { requiresManualInstall } = getAppState().updater;

  const run = requiresManualInstall
    ? installViaPkgInstaller
    : installViaBuiltInUpdater;

  installingPromise = run()
    .then(async (succeeded) => {
      if (!succeeded) {
        return;
      }

      if (requiresManualInstall) {
        // The .pkg installer will replace the app externally; no relaunch
        // needed from here. Just release the stored update handle.
        await closeAvailableUpdate();
        return;
      }

      markSurfaceWindowForNextLaunch();
      await closeAvailableUpdate();
      try {
        await relaunchApp();
      } catch (error) {
        console.error("Failed to relaunch after update", error);
      }
    })
    .finally(() => {
      installingPromise = null;
    });

  await installingPromise;
};
