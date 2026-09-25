import { NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { getIntl } from "../i18n";
import { getLogger } from "../utils/log.utils";
import { produceAppState } from "../store";
import { showErrorSnackbar } from "./app.actions";
import { getNativeRepo } from "../repos";

/**
 * Ask Windows to relaunch the process elevated (UAC). The decision to call
 * this stays on the frontend; Rust only performs the ShellExecuteW bootstrap.
 *
 * Outcomes:
 * - elevated already / non-Windows → `"success"` (no-op)
 * - UAC accepted → process exits via `app.exit(0)` after the helper spawns
 * - UAC declined → `"cancelled"` and the decline dialog is opened; the
 *   elevation startup gate stays pending until the user picks an action
 * - other failure → snackbar; caller should release the startup gate
 */
export async function requestAdminRelaunch(): Promise<NativeSetupResult | null> {
  let result: NativeSetupResult;
  try {
    result = await getNativeRepo().requestAdminRelaunch();
  } catch (error) {
    getLogger().error(`Administrator relaunch failed: ${error}`);
    showErrorSnackbar(error);
    return null;
  }

  getLogger().info(`Administrator relaunch result: ${result}`);
  if (result === "cancelled") {
    produceAppState((draft) => {
      draft.settings.elevationDeclinedDialogOpen = true;
    });
  } else if (result === "failed") {
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
    getLogger().error(`Failed to quit application: ${error}`);
    showErrorSnackbar(error);
  }
}
