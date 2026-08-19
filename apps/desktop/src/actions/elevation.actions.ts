import type { NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { getUserPreferencesRepo } from "../repos";
import type { AppState } from "../state/app.state";
import { produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import type { Platform } from "../utils/platform.utils";
import { quitApp, requestAdminRelaunch } from "./native.actions";

/** Single write-site for releasing the startup elevation gate. */
const applyElevationStartupGateRelease = (draft: AppState): void => {
  draft.settings.elevationStartupPending = false;
};

/** Clear the pre-flight gate so auth / dashboard init can proceed. */
export const releaseElevationStartupGate = (): void => {
  produceAppState(applyElevationStartupGateRelease);
};

/**
 * "Launch normally" after a declined UAC prompt: close the helper dialog
 * and release the gate in one store update so the two cannot drift.
 */
export const launchNormallyAfterElevationDecline = (): void => {
  produceAppState((draft) => {
    draft.settings.elevationDeclinedDialogOpen = false;
    applyElevationStartupGateRelease(draft);
  });
};

/** "Close mausVoice" — process exit, not hide-to-tray. */
export const quitAfterElevationDecline = (): Promise<void> => quitApp();

export const shouldRunStartupElevation = (opts: {
  isMainWindow: boolean;
  platform: Platform;
}): boolean => opts.isMainWindow && opts.platform === "windows";

/**
 * After `requestAdminRelaunch`, keep the gate closed on cancel (the decline
 * dialog owns the next transition) and on require-restart (this process is
 * exiting). Every other outcome — already elevated, failed, or invoke error —
 * continues unelevated startup.
 */
export const shouldReleaseElevationGateAfterRelaunch = (
  result: NativeSetupResult | null,
): boolean => result !== "cancelled" && result !== "require-restart";

export const isReadyForFullApp = (opts: {
  initialized: boolean;
  elevationStartupPending: boolean;
}): boolean => opts.initialized && !opts.elevationStartupPending;

export const shouldMountPostElevationSideEffects = (
  elevationStartupPending: boolean,
): boolean => !elevationStartupPending;

/**
 * Windows "Always run as administrator" pre-flight.
 *
 * Reads only the admin-on-startup bit from prefs (no auth), then either
 * relaunches elevated or leaves the gate pending for the decline dialog.
 * Callers must invoke this before attaching auth listeners.
 */
export const runStartupElevationPreflight = async (opts: {
  isMainWindow: boolean;
  platform: Platform;
}): Promise<void> => {
  if (!shouldRunStartupElevation(opts)) {
    releaseElevationStartupGate();
    return;
  }

  let wantsAdmin = false;
  try {
    const stored = await getUserPreferencesRepo().getUserPreferences();
    wantsAdmin = stored?.alwaysRequestAdminOnStartup === true;
    // Seed the store early so later init sees a consistent prefs snapshot
    // without waiting on auth. refreshCurrentUser will overwrite if needed.
    if (stored) {
      produceAppState((draft) => {
        draft.userPrefs = stored;
      });
    }
  } catch (error) {
    getLogger().warning(
      `Failed to read admin-on-startup preference; continuing without elevation: ${error}`,
    );
    releaseElevationStartupGate();
    return;
  }

  if (!wantsAdmin) {
    releaseElevationStartupGate();
    return;
  }

  getLogger().info("Requesting administrator relaunch before full app startup");
  const result = await requestAdminRelaunch();
  if (shouldReleaseElevationGateAfterRelaunch(result)) {
    releaseElevationStartupGate();
  }
};
