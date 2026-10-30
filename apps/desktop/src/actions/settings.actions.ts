import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { produceAppState, getAppState } from "../store";
import type { LocalDataWriteLease } from "../utils/local-data-write-gate";
import { showErrorSnackbar } from "./app.actions";

const isTauriEnvironment = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const tauriWindow = window as typeof window & Record<string, unknown>;
  return (
    "__TAURI_INTERNALS__" in tauriWindow ||
    "__TAURI__" in tauriWindow ||
    "__TAURI_IPC__" in tauriWindow
  );
};

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

export const setAutoLaunchEnabled = async (
  enabled: boolean,
  lease?: LocalDataWriteLease,
): Promise<void> => {
  if (!isTauriEnvironment()) {
    produceAppState((draft) => {
      draft.settings.autoLaunchEnabled = enabled;
      draft.settings.autoLaunchStatus = "success";
    }, lease);
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
  }, lease);

  try {
    if (enabled) {
      await enable();
    } else {
      await disable();
    }

    produceAppState((draft) => {
      draft.settings.autoLaunchStatus = "success";
    }, lease);
  } catch (error) {
    console.error("Failed to update auto-start preference", error);
    produceAppState((draft) => {
      draft.settings.autoLaunchEnabled = previous;
      draft.settings.autoLaunchStatus = "error";
    }, lease);
    showErrorSnackbar(
      "Unable to update auto start preference. Please try again.",
    );
  }
};
