import type { NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { getUserPreferencesRepo } from "../repos";
import type { AppState } from "../state/app.state";
import { produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import type { Platform } from "../utils/platform.utils";
import { setUserPreferences } from "../utils/user.utils";
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

/** True once the Windows elevation pre-flight has released the startup gate. */
export const isElevationStartupReady = (
  elevationStartupPending: boolean,
): boolean => !elevationStartupPending;

/**
 * Single predicate for every post-gate init step (auth, streams, receivers,
 * final `initialized`, router). Extra prerequisites stay local to the step.
 */
export const canRunPostElevationInit = (
  elevationReady: boolean,
  ...prerequisites: boolean[]
): boolean => elevationReady && prerequisites.every(Boolean);

export const isReadyForFullApp = (
  initialized: boolean,
  elevationReady: boolean,
): boolean => canRunPostElevationInit(elevationReady, initialized);

// The whole app gates on this pre-flight, so neither the prefs read nor the
// native relaunch may wait forever: a hung SQLite query or IPC call would
// otherwise pin the UI on the loading screen with no way out.
const PREFLIGHT_PREFS_TIMEOUT_MS = 15_000;
// Generous: a UAC prompt can sit unread while the user is away. The watchdog
// exists for a genuinely hung IPC, not for a slow human.
const ELEVATION_RELAUNCH_WATCHDOG_MS = 5 * 60_000;

const awaitWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

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
    const stored = await awaitWithTimeout(
      getUserPreferencesRepo().getUserPreferences(),
      PREFLIGHT_PREFS_TIMEOUT_MS,
      "Reading startup elevation preference",
    );
    wantsAdmin = stored?.alwaysRequestAdminOnStartup === true;
    // Seed the store early so later init sees a consistent prefs snapshot
    // without waiting on auth. Route through the shared write-site so the
    // derived feature settings apply exactly like a normal prefs load.
    // refreshCurrentUser will overwrite if needed.
    if (stored) {
      produceAppState((draft) => {
        setUserPreferences(draft, stored);
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
  let relaunchLapsed = false;
  const relaunch = requestAdminRelaunch().then((result) => {
    // A result arriving after the watchdog must not reopen the gate or
    // restart an app that already launched unelevated.
    if (relaunchLapsed) {
      getLogger().warning(
        "Ignoring administrator relaunch result that arrived after the startup watchdog",
      );
      return null;
    }
    return result;
  });
  let result: NativeSetupResult | null;
  try {
    result = await awaitWithTimeout(
      relaunch,
      ELEVATION_RELAUNCH_WATCHDOG_MS,
      "Administrator relaunch",
    );
  } catch (error) {
    relaunchLapsed = true;
    getLogger().warning(
      `Administrator relaunch did not settle; continuing without elevation: ${error}`,
    );
    result = null;
  }
  // `null` covers both a watchdog lapse and a relaunch that errored
  // internally; both must start unelevated rather than hold the gate.
  if (result === null || shouldReleaseElevationGateAfterRelaunch(result)) {
    releaseElevationStartupGate();
  }
};
