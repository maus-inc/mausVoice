import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "@maus-inc/desktop-native-apis";
import { useEffect } from "react";
import type { IntlShape } from "react-intl";
import { setActiveDictationLanguage } from "../actions/user.actions";
import { useAppStore } from "../store";
import { observeDashboardMenu } from "../utils/dashboard-menu-observer";
import { getLocalizedDashboardMenuLabels } from "../utils/tray-dashboard-visibility.utils";
import { buildTrayLanguageMenuModel } from "../utils/tray-language.utils";
import { useTauriListen } from "./tauri.hooks";

/** Synchronize the tray menu with persisted settings and window state. */
export function useTrayMenuSync({
  isMainWindow,
  intl,
  menuBarIconHidden,
}: {
  isMainWindow: boolean;
  intl: IntlShape;
  menuBarIconHidden: boolean;
}) {
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_tray_visible", { visible: !menuBarIconHidden }).catch(
      console.error,
    );
  }, [isMainWindow, menuBarIconHidden]);

  // Re-push the tray Language submenu whenever the Active Dictation Language or
  // the configured language set changes, keeping the tray correct after both
  // tray clicks and settings edits.
  const trayLanguageMenuKey = useAppStore((state) =>
    JSON.stringify(buildTrayLanguageMenuModel(state)),
  );
  useEffect(() => {
    if (!isMainWindow) return;
    invoke("set_tray_language_menu", {
      items: JSON.parse(trayLanguageMenuKey),
    }).catch(console.error);
  }, [isMainWindow, trayLanguageMenuKey]);

  useTauriListen<string>("tray-set-dictation-language", (code) => {
    if (!isMainWindow) return;
    setActiveDictationLanguage(code).catch(console.error);
  });

  // The native command reads the real window state; these events only trigger
  // a debounced re-sync after OS-driven minimize, close-to-tray, and surface
  // transitions. Rust retains both localized labels so a tray click can update
  // the item synchronously without waiting for the webview.
  useEffect(() => {
    if (!isMainWindow) return;

    const appWindow = getCurrentWindow();
    const labels = getLocalizedDashboardMenuLabels(intl);
    return observeDashboardMenu({
      subscribe: [
        (sync) => appWindow.onFocusChanged(sync),
        (sync) => appWindow.onResized(sync),
        (sync) => appWindow.onCloseRequested(sync),
      ],
      push: () =>
        commands
          .setDashboardMenuLabels(labels.openLabel, labels.hideLabel)
          .catch(console.error),
      onError: (error) => {
        console.warn("[AppSideEffects] window listener cleanup failed", error);
      },
    });
  }, [intl, isMainWindow]);
}
