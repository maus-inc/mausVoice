import { NativeSetupResult } from "@maus-inc/desktop-native-apis";
import { getIntl } from "../i18n";
import { getLogger } from "../utils/log.utils";
import { produceAppState } from "../store";
import { showErrorSnackbar } from "./app.actions";
import { getNativeRepo } from "../repos";

export async function requestAdminRelaunch(): Promise<void> {
  let result: NativeSetupResult;
  try {
    result = await getNativeRepo().requestAdminRelaunch();
  } catch (error) {
    getLogger().error(`Administrator relaunch failed: ${error}`);
    showErrorSnackbar(error);
    return;
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
}
