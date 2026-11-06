import { getCurrentWindow } from "@tauri-apps/api/window";
import { useIntl } from "react-intl";
import { useAppAnalytics } from "../../hooks/app-analytics.hooks";
import { useAppAuthBootstrap } from "../../hooks/app-auth-bootstrap.hooks";
import { useAppChrome } from "../../hooks/app-chrome.hooks";
import { useAppRuntimeEffects } from "../../hooks/app-runtime-effects.hooks";

/** Mount the app's window-scoped runtime, account and UI side effects. */
export const AppSideEffects = () => {
  const intl = useIntl();
  const isMainWindow = getCurrentWindow().label === "main";
  useAppRuntimeEffects({ isMainWindow, intl });
  useAppAuthBootstrap(isMainWindow);
  useAppAnalytics();
  useAppChrome({ isMainWindow, intl });
  return null;
};
