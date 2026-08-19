import type { UserPreferences } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { createDefaultPreferences } from "./user.actions";

const { prefsRepoMock, requestAdminRelaunchMock, quitAppMock, loggerMock } =
  vi.hoisted(() => ({
    prefsRepoMock: {
      getUserPreferences: vi.fn(),
    },
    requestAdminRelaunchMock: vi.fn(),
    quitAppMock: vi.fn(async () => undefined),
    loggerMock: {
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      verbose: vi.fn(),
    },
  }));

vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => prefsRepoMock,
}));

vi.mock("./native.actions", () => ({
  requestAdminRelaunch: requestAdminRelaunchMock,
  quitApp: quitAppMock,
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

const {
  isReadyForFullApp,
  launchNormallyAfterElevationDecline,
  quitAfterElevationDecline,
  releaseElevationStartupGate,
  runStartupElevationPreflight,
  shouldMountPostElevationSideEffects,
  shouldReleaseElevationGateAfterRelaunch,
  shouldRunStartupElevation,
} = await import("./elevation.actions");

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const prefsWithAdmin = (enabled: boolean): UserPreferences => ({
  ...createDefaultPreferences(),
  alwaysRequestAdminOnStartup: enabled,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

afterEach(() => {
  vi.clearAllMocks();
  resetState();
});

describe("elevation gate state transitions", () => {
  it("releaseElevationStartupGate clears only the pending flag", () => {
    setAppState({
      settings: {
        ...getAppState().settings,
        elevationStartupPending: true,
        elevationDeclinedDialogOpen: true,
      },
    });

    releaseElevationStartupGate();

    expect(getAppState().settings.elevationStartupPending).toBe(false);
    expect(getAppState().settings.elevationDeclinedDialogOpen).toBe(true);
  });

  it("launchNormallyAfterElevationDecline closes the dialog and releases the gate", () => {
    setAppState({
      settings: {
        ...getAppState().settings,
        elevationStartupPending: true,
        elevationDeclinedDialogOpen: true,
      },
    });

    launchNormallyAfterElevationDecline();

    expect(getAppState().settings.elevationStartupPending).toBe(false);
    expect(getAppState().settings.elevationDeclinedDialogOpen).toBe(false);
  });

  it("quitAfterElevationDecline delegates to quitApp", async () => {
    await quitAfterElevationDecline();
    expect(quitAppMock).toHaveBeenCalledTimes(1);
  });
});

describe("elevation gate policy", () => {
  it("runs only on the Windows main window", () => {
    expect(
      shouldRunStartupElevation({ isMainWindow: true, platform: "windows" }),
    ).toBe(true);
    expect(
      shouldRunStartupElevation({ isMainWindow: false, platform: "windows" }),
    ).toBe(false);
    expect(
      shouldRunStartupElevation({ isMainWindow: true, platform: "macos" }),
    ).toBe(false);
    expect(
      shouldRunStartupElevation({ isMainWindow: true, platform: "linux" }),
    ).toBe(false);
  });

  it("holds the gate after cancel or require-restart", () => {
    expect(shouldReleaseElevationGateAfterRelaunch("cancelled")).toBe(false);
    expect(shouldReleaseElevationGateAfterRelaunch("require-restart")).toBe(
      false,
    );
    expect(shouldReleaseElevationGateAfterRelaunch("success")).toBe(true);
    expect(shouldReleaseElevationGateAfterRelaunch("failed")).toBe(true);
    expect(shouldReleaseElevationGateAfterRelaunch(null)).toBe(true);
  });

  it("keeps the router behind both initialized and the elevation gate", () => {
    expect(
      isReadyForFullApp({
        initialized: false,
        elevationStartupPending: true,
      }),
    ).toBe(false);
    expect(
      isReadyForFullApp({
        initialized: true,
        elevationStartupPending: true,
      }),
    ).toBe(false);
    expect(
      isReadyForFullApp({
        initialized: false,
        elevationStartupPending: false,
      }),
    ).toBe(false);
    expect(
      isReadyForFullApp({
        initialized: true,
        elevationStartupPending: false,
      }),
    ).toBe(true);
  });

  it("mounts heavy side-effects only after the gate is released", () => {
    expect(shouldMountPostElevationSideEffects(true)).toBe(false);
    expect(shouldMountPostElevationSideEffects(false)).toBe(true);
  });
});

describe("runStartupElevationPreflight", () => {
  it("releases the gate without reading prefs off the Windows main window", async () => {
    await runStartupElevationPreflight({
      isMainWindow: true,
      platform: "macos",
    });

    expect(prefsRepoMock.getUserPreferences).not.toHaveBeenCalled();
    expect(requestAdminRelaunchMock).not.toHaveBeenCalled();
    expect(getAppState().settings.elevationStartupPending).toBe(false);
  });

  it("releases the gate when the admin-on-startup pref is off", async () => {
    prefsRepoMock.getUserPreferences.mockResolvedValueOnce(
      prefsWithAdmin(false),
    );

    await runStartupElevationPreflight({
      isMainWindow: true,
      platform: "windows",
    });

    expect(requestAdminRelaunchMock).not.toHaveBeenCalled();
    expect(getAppState().settings.elevationStartupPending).toBe(false);
    expect(getAppState().userPrefs?.alwaysRequestAdminOnStartup).toBe(false);
  });

  it("releases the gate when the prefs read fails", async () => {
    prefsRepoMock.getUserPreferences.mockRejectedValueOnce(
      new Error("sqlite down"),
    );

    await runStartupElevationPreflight({
      isMainWindow: true,
      platform: "windows",
    });

    expect(requestAdminRelaunchMock).not.toHaveBeenCalled();
    expect(getAppState().settings.elevationStartupPending).toBe(false);
    expect(loggerMock.warning).toHaveBeenCalled();
  });

  it("holds the gate on cancelled so Launch normally owns the release", async () => {
    prefsRepoMock.getUserPreferences.mockResolvedValueOnce(
      prefsWithAdmin(true),
    );
    requestAdminRelaunchMock.mockResolvedValueOnce("cancelled");

    await runStartupElevationPreflight({
      isMainWindow: true,
      platform: "windows",
    });

    expect(requestAdminRelaunchMock).toHaveBeenCalledTimes(1);
    expect(getAppState().settings.elevationStartupPending).toBe(true);

    launchNormallyAfterElevationDecline();
    expect(getAppState().settings.elevationStartupPending).toBe(false);
  });

  it("holds the gate on require-restart until process exit", async () => {
    prefsRepoMock.getUserPreferences.mockResolvedValueOnce(
      prefsWithAdmin(true),
    );
    requestAdminRelaunchMock.mockResolvedValueOnce("require-restart");

    await runStartupElevationPreflight({
      isMainWindow: true,
      platform: "windows",
    });

    expect(getAppState().settings.elevationStartupPending).toBe(true);
  });

  it.each(["success", "failed", null] as const)(
    "releases the gate after relaunch result %s",
    async (result) => {
      prefsRepoMock.getUserPreferences.mockResolvedValueOnce(
        prefsWithAdmin(true),
      );
      requestAdminRelaunchMock.mockResolvedValueOnce(result);

      await runStartupElevationPreflight({
        isMainWindow: true,
        platform: "windows",
      });

      expect(getAppState().settings.elevationStartupPending).toBe(false);
    },
  );
});
