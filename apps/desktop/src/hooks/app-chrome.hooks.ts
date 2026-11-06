import type { IntlShape } from "react-intl";
import { showSnackbar } from "../actions/app.actions";
import { useAppStore } from "../store";
import { getIsDevMode } from "../utils/env.utils";
import { getMyUserPreferences } from "../utils/user.utils";
import { useAddSelectionToDictionary } from "./add-selection-to-dictionary.hooks";
import { useAppToastNavigation } from "./app-toast-navigation.hooks";
import { useAppTrayActions } from "./app-tray-actions.hooks";
import { useKeyDownHandler } from "./helper.hooks";
import { useTrayMenuSync } from "./tray-menu-sync.hooks";
import { useTrayPillControls } from "./tray-pill-controls.hooks";

/** Own user-facing shortcuts, toast actions and tray integrations. */
export function useAppChrome({
  isMainWindow,
  intl,
}: {
  isMainWindow: boolean;
  intl: IntlShape;
}) {
  const prefs = useAppStore((state) => getMyUserPreferences(state));
  useAddSelectionToDictionary({ isMainWindow, intl });

  // You cannot refresh the page in Tauri, here's a hotkey to help with that
  useKeyDownHandler({
    keys: ["r"],
    ctrl: true,
    callback: () => {
      if (getIsDevMode()) {
        showSnackbar("Refreshing application...");
        window.location.href = "/welcome";
      }
    },
  });

  // Hotkey to open settings (Cmd+, on macOS)
  useKeyDownHandler({
    keys: [","],
    meta: true,
    callback: () => {
      if (window.location.pathname !== "/dashboard/settings") {
        window.location.href = "/dashboard/settings";
      }
    },
  });

  useAppToastNavigation();

  useAppTrayActions(isMainWindow);

  useTrayMenuSync({
    isMainWindow,
    intl,
    menuBarIconHidden: prefs?.menuBarIconHidden ?? false,
  });

  useTrayPillControls({
    isMainWindow,
    intl,
    visibility: prefs?.dictationPillVisibility,
  });
}
