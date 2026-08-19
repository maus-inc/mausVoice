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

const getWindowsBuildNumber = (userAgent: string): number | null => {
  const match = /Windows NT 10\.0.*build[:/\s]*(\d+)/i.exec(userAgent);
  return match ? Number.parseInt(match[1], 10) : null;
};

export const isWindows10 = (): boolean => {
  if (!isWindows()) {
    return false;
  }

  const userAgent = navigator.userAgent;
  const build = getWindowsBuildNumber(userAgent);
  if (build !== null) {
    return build < 22000;
  }

  return userAgent.includes("Windows NT 10.0");
};

const WIN11_MIN_BUILD = 22000;

type NavigatorUAData = {
  platformVersion?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ uaFullVersion?: string; platformVersion?: string }>;
};

let cachedUaChWin11: boolean | null = null;

const readCachedPlatformVersion = (): string | undefined => {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData;
  if (typeof uaData?.platformVersion === "string") {
    return uaData.platformVersion;
  }
  if (uaData?.getHighEntropyValues && cachedUaChWin11 === null) {
    void uaData
      .getHighEntropyValues(["uaFullVersion", "platformVersion"])
      .then((values) => {
        const major = Number.parseInt(
          (values.platformVersion ?? "").split(".")[0] ?? "",
          10,
        );
        cachedUaChWin11 = Number.isFinite(major) ? major >= 13 : null;
      })
      .catch(() => {
        cachedUaChWin11 = false;
      });
  }
  return undefined;
};

export const isWindows11 = (): boolean => {
  if (!isWindows()) {
    return false;
  }

  const build = getWindowsBuildNumber(navigator.userAgent);
  if (build !== null) {
    return build >= WIN11_MIN_BUILD;
  }

  const platformVersion = readCachedPlatformVersion();
  if (platformVersion) {
    const major = Number.parseInt(platformVersion.split(".")[0] ?? "", 10);
    return Number.isFinite(major) && major >= 13;
  }

  if (cachedUaChWin11 !== null) {
    return cachedUaChWin11;
  }

  return /Windows 11/i.test(navigator.userAgent);
};
