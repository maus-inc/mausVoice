export type UpdaterStatus =
  "idle" | "checking" | "ready" | "downloading" | "installing" | "error";

export type UpdaterState = {
  dialogOpen: boolean;
  status: UpdaterStatus;
  currentVersion: string | null;
  availableVersion: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  manualInstallerUrl: string | null;
  manualInstallerSignatureUrl: string | null;
  requiresManualInstall: boolean;
  downloadedBytes: number | null;
  totalBytes: number | null;
  downloadProgress: number | null;
  errorMessage: string | null;
  dismissedUntil: number | null;
  lastCheckedAt: number | null;
  /**
   * True once a user-initiated check completed and found nothing. Cleared by
   * the next check so the "You're up to date" confirmation does not linger.
   */
  upToDateConfirmed: boolean;
};

export const INITIAL_UPDATER_STATE: UpdaterState = {
  dialogOpen: false,
  status: "idle",
  currentVersion: null,
  availableVersion: null,
  releaseDate: null,
  releaseNotes: null,
  manualInstallerUrl: null,
  manualInstallerSignatureUrl: null,
  requiresManualInstall: false,
  downloadedBytes: null,
  totalBytes: null,
  downloadProgress: null,
  errorMessage: null,
  dismissedUntil: null,
  lastCheckedAt: null,
  upToDateConfirmed: false,
};
