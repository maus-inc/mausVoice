import {
  detectDesktopPlatform,
  type DesktopPlatform,
} from "@maus-inc/desktop-utils";

/**
 * True when the bundle is running inside the Tauri webview rather than a plain
 * browser (unit tests, Storybook, `vite dev` in a tab). Window-chrome features
 * — drag region, resize grips, minimise/maximise/close — must no-op outside it.
 */
export const isTauriRuntime = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  const tauriWindow = window as typeof window & Record<string, unknown>;
  return "__TAURI_INTERNALS__" in tauriWindow || "__TAURI__" in tauriWindow;
};

export const getIsDevMode = (): boolean => {
  return import.meta.env.DEV;
};

export const getIsEmulators = (): boolean => {
  return (
    getIsDevMode() && (import.meta.env.VITE_USE_EMULATORS ?? "true") === "true"
  );
};

export type Flavor =
  "emulators" | "dev" | "prod" | "enterprise" | "enterprise-dev";
export const getFlavor = (): Flavor =>
  (import.meta.env.VITE_FLAVOR ?? "emulators") as Flavor;

export const isEmulators = () => getFlavor() === "emulators";
export const isDev = () => getFlavor() === "dev";
export const isProd = () => getFlavor() === "prod";

export type Platform = DesktopPlatform;

export const getPlatform = (): Platform => {
  const override = import.meta.env.MAUSVOICE_DESKTOP_PLATFORM as
    Platform | undefined;
  if (override) {
    return override;
  }

  return detectDesktopPlatform();
};

export const isMacOS = (): boolean => getPlatform() === "darwin";
export const isWindows = (): boolean => getPlatform() === "win32";

export const isWindows10 = (): boolean => {
  if (!isWindows()) {
    return false;
  }

  const userAgent = navigator.userAgent;
  const match = userAgent.match(/Windows NT 10\.0.*build[:/\s]*(\d+)/i);
  if (match) {
    const build = parseInt(match[1], 10);
    return build < 22000;
  }

  const uaData = (
    navigator as Navigator & { userAgentData?: { platform: string } }
  ).userAgentData;
  if (uaData?.platform === "Windows") {
    return userAgent.includes("Windows NT 10.0");
  }

  return userAgent.includes("Windows NT 10.0");
};

export const isWindows11 = (): boolean => {
  if (!isWindows()) {
    return false;
  }

  const userAgent = navigator.userAgent;
  const match = userAgent.match(/Windows NT 10\.0.*build[:/\s]*(\d+)/i);
  if (match) {
    const build = parseInt(match[1], 10);
    return build >= 22000;
  }

  return false;
};
