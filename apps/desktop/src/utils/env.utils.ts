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

const WIN11_MIN_BUILD = 22000;

const getWindowsBuildNumber = (userAgent: string): number | null => {
  const match = /Windows NT 10\.0.*build[:/\s]*(\d+)/i.exec(userAgent);
  return match ? Number.parseInt(match[1], 10) : null;
};

export const isWindows10 = (): boolean => {
  if (!isWindows()) {
    return false;
  }

  if (isWindows11()) {
    return false;
  }

  const userAgent = navigator.userAgent;
  const build = getWindowsBuildNumber(userAgent);
  if (build !== null) {
    return build < WIN11_MIN_BUILD;
  }

  return userAgent.includes("Windows NT 10.0");
};

type NavigatorUAData = {
  platformVersion?: string;
  getHighEntropyValues?: (
    hints: string[],
  ) => Promise<{ uaFullVersion?: string; platformVersion?: string }>;
};

const getNavigatorUAData = (): NavigatorUAData | undefined => {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  return (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData;
};

const win11FromPlatformVersion = (platformVersion: string): boolean | null => {
  const major = Number.parseInt(platformVersion.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major >= 13 : null;
};

const detectWindows11Sync = (): boolean | null => {
  if (!isWindows()) {
    return false;
  }

  const build = getWindowsBuildNumber(navigator.userAgent);
  if (build !== null) {
    return build >= WIN11_MIN_BUILD;
  }

  const uaData = getNavigatorUAData();
  if (typeof uaData?.platformVersion === "string") {
    const fromHint = win11FromPlatformVersion(uaData.platformVersion);
    if (fromHint !== null) {
      return fromHint;
    }
  }

  if (/Windows 11/i.test(navigator.userAgent)) {
    return true;
  }

  return null;
};

let cachedUaChWin11: boolean | null = null;
let uaChLookup: Promise<boolean | null> | undefined;

const lookupWindows11ViaUaCh = (): Promise<boolean | null> => {
  if (uaChLookup) {
    return uaChLookup;
  }

  const uaData = getNavigatorUAData();
  if (!uaData?.getHighEntropyValues) {
    uaChLookup = Promise.resolve(null);
    return uaChLookup;
  }

  uaChLookup = uaData
    .getHighEntropyValues(["uaFullVersion", "platformVersion"])
    .then((values) => {
      if (values.platformVersion) {
        return win11FromPlatformVersion(values.platformVersion);
      }
      return null;
    })
    .catch(() => null)
    .then((result) => {
      cachedUaChWin11 = result;
      return result;
    });

  return uaChLookup;
};

if (typeof navigator !== "undefined") {
  void lookupWindows11ViaUaCh();
}

export const isWindows11 = (): boolean => {
  const sync = detectWindows11Sync();
  if (sync !== null) {
    return sync;
  }
  return cachedUaChWin11 === true;
};

export const resolveIsWindows11 = async (): Promise<boolean> => {
  const sync = detectWindows11Sync();
  if (sync !== null) {
    return sync;
  }
  const fromUaCh = cachedUaChWin11 ?? (await lookupWindows11ViaUaCh());
  return fromUaCh === true;
};
