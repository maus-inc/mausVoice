import { NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { getIntl } from "../i18n";
import { getLogger } from "../utils/log.utils";
import { showErrorSnackbar } from "./app.actions";
import { getNativeRepo } from "../repos";

/**
 * Ask Windows to relaunch the process elevated (UAC). The decision to call
 * this stays on the frontend; Rust only performs the ShellExecuteW bootstrap.
 *
 * Outcomes:
 * - elevated already / non-Windows → `"success"` (no-op)
 * - UAC accepted → process exits via `app.exit(0)` after the helper spawns
 * - UAC declined → `"cancelled"`; the caller owns the decline dialog, because
 *   only the caller knows whether the result still arrives inside the window it
 *   is waiting for (see `openElevationDeclinedDialog`)
 * - other failure → snackbar; caller should release the startup gate
 */
export async function requestAdminRelaunch(): Promise<NativeSetupResult | null> {
  let result: NativeSetupResult;
  try {
    result = await getNativeRepo().requestAdminRelaunch();
  } catch (error) {
    // The native exception is a developer string (a Tauri command name, an OS
    // error code) and `showErrorSnackbar` renders it verbatim, so it stays in
    // the log and the user gets the same localized sentence as an explicit
    // "failed" result.
    getLogger().error(`Administrator relaunch failed: ${error}`);
    showErrorSnackbar(
      getIntl().formatMessage({
        defaultMessage: "Failed to restart mausVoice as administrator.",
      }),
    );
    return null;
  }

  getLogger().info(`Administrator relaunch result: ${result}`);
  if (result === "failed") {
    showErrorSnackbar(
      getIntl().formatMessage({
        defaultMessage: "Failed to restart mausVoice as administrator.",
      }),
    );
  }
  return result;
}

/** Terminate the process and tray. Does not hide-to-tray. */
export async function quitApp(): Promise<void> {
  try {
    await getNativeRepo().quitApp();
  } catch (error) {
    // Same rule as the relaunch failure above: the native exception is the
    // developer's detail and the snackbar is localized copy.
    getLogger().error(`Failed to quit application: ${error}`);
    showErrorSnackbar(
      getIntl().formatMessage({
        defaultMessage:
          "Could not close mausVoice. Try again or force quit it.",
      }),
    );
  }
}
