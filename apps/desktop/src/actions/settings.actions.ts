import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isTauriEnvironment } from "../sidecars/sidecar.utils";
import { produceAppState, getAppState } from "../store";
import { showErrorSnackbar } from "./app.actions";

export const syncAutoLaunchSetting = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    produceAppState((draft) => {
      draft.settings.autoLaunchStatus = "success";
      draft.settings.autoLaunchEnabled = false;
    });
    return;
  }

  produceAppState((draft) => {
    draft.settings.autoLaunchStatus = "loading";
  });

  try {
    const enabled = await isEnabled();
    produceAppState((draft) => {
      draft.settings.autoLaunchEnabled = enabled;
      draft.settings.autoLaunchStatus = "success";
    });
  } catch (error) {
    console.error("Failed to determine auto-start status", error);
    produceAppState((draft) => {
      draft.settings.autoLaunchStatus = "error";
    });
  }
};

export const setAutoLaunchEnabled = async (enabled: boolean): Promise<void> => {
  if (!isTauriEnvironment()) {
    produceAppState((draft) => {
      draft.settings.autoLaunchEnabled = enabled;
      draft.settings.autoLaunchStatus = "success";
    });
    return;
  }

  const state = getAppState();
  if (state.settings.autoLaunchStatus === "loading") {
    return;
  }

  const previous = state.settings.autoLaunchEnabled;

  produceAppState((draft) => {
    draft.settings.autoLaunchEnabled = enabled;
    draft.settings.autoLaunchStatus = "loading";
  });

  try {
    if (enabled) {
      await enable();
    } else {
      await disable();
    }

    produceAppState((draft) => {
      draft.settings.autoLaunchStatus = "success";
    });
  } catch (error) {
    console.error("Failed to update auto-start preference", error);
    produceAppState((draft) => {
      draft.settings.autoLaunchEnabled = previous;
      draft.settings.autoLaunchStatus = "error";
    });
    showErrorSnackbar(
      "Unable to update auto start preference. Please try again.",
    );
  }
};
