import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import type { UserPreferences } from "@maus-inc/types";
import { createDefaultPreferences, setUpdateChannel } from "./user.actions";

const { updaterMock, toastMock, invokeMock, savePreferences } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(async () => null),
    savePreferences: vi.fn(async (preferences: UserPreferences) => preferences),
    updaterMock: {
      checkForUpdate: vi.fn(),
      checkForChannelUpdate: vi.fn(async (...args: unknown[]) =>
        (updaterMock.checkForUpdate as (...callArgs: unknown[]) => unknown)(
          ...args,
        ),
      ),
      hasAvailableUpdate: vi.fn(() => false),
      closeAvailableUpdate: vi.fn(async () => {}),
      installAvailableUpdate: vi.fn(async () => {}),
      downloadAndOpenMacInstaller: vi.fn(async () => {}),
      relaunchApp: vi.fn(async () => {}),
      isReadOnlyFilesystemInstallError: vi.fn(() => false),
    },
    toastMock: { showToast: vi.fn((): Promise<void> => Promise.resolve()) },
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@maus-inc/desktop-utils", () => updaterMock);
vi.mock("./toast.actions", async () => ({
  ...toastMock,
  runToast: (await import("../../test/helpers/toast-mock")).runToastMock,
}));
vi.mock("../repos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repos")>()),
  getUserPreferencesRepo: () => ({ setUserPreferences: savePreferences }),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));
vi.mock("../utils/window.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/window.utils")>()),
  markSurfaceWindowForNextLaunch: vi.fn(),
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: vi.fn() }));
// Only the platform probe is stubbed; app.state pulls other env helpers in
// transitively, so the rest of the module must stay real.
vi.mock("../utils/env.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/env.utils")>()),
  getPlatform: () => "darwin",
}));
vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));

const { checkForAppUpdates } = await import("./updater.actions");

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

beforeEach(() => {
  vi.clearAllMocks();
  updaterMock.hasAvailableUpdate.mockReturnValue(false);
  savePreferences
    .mockReset()
    .mockImplementation(async (preferences) => preferences);
  resetState();
});

afterEach(() => {
  vi.clearAllMocks();
  resetState();
});

const availableUpdate = {
  currentVersion: "0.1.6",
  version: "0.1.7",
  releaseDate: "2026-08-01T00:00:00.000Z",
  releaseNotes: "Fixes the updater.",
  manualInstallerUrl: null,
  requiresManualInstall: false,
};

describe("checkForAppUpdates", () => {
  it("never writes a dismissal window on its own", async () => {
    // Regression: startup used to call dismissUpdateDialog() to mark the
    // first tick, which snoozed the dialog for three days on every launch.
    updaterMock.checkForUpdate.mockResolvedValue(null);

    await checkForAppUpdates();

    expect(getAppState().updater.dismissedUntil).toBeNull();
  });

  it("records when it last checked, whatever the outcome", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(null);
    const before = Date.now();

    await checkForAppUpdates();

    const { lastCheckedAt } = getAppState().updater;
    expect(lastCheckedAt).not.toBeNull();
    expect(lastCheckedAt as number).toBeGreaterThanOrEqual(before);
  });

  it("stamps the check time even when the endpoint fails", async () => {
    updaterMock.checkForUpdate.mockRejectedValue(new Error("offline"));

    const available = await checkForAppUpdates();

    expect(available).toBe(false);
    const { status, lastCheckedAt } = getAppState().updater;
    expect(status).toBe("error");
    expect(lastCheckedAt).not.toBeNull();
  });

  it("clears the previous offer, dialog, native handle and tray badge after a failed check", async () => {
    updaterMock.checkForUpdate.mockResolvedValueOnce({
      ...availableUpdate,
      requiresManualInstall: true,
      manualInstallerUrl: "https://example.com/installer.dmg",
      manualInstallerSignatureUrl: "https://example.com/installer.dmg.sig",
    });
    await checkForAppUpdates({ userInitiated: true });
    expect(getAppState().updater.dialogOpen).toBe(true);
    expect(getAppState().updater.availableVersion).toBe("0.1.7");
    updaterMock.closeAvailableUpdate.mockClear();
    updaterMock.checkForUpdate.mockRejectedValueOnce(new Error("offline"));

    await expect(checkForAppUpdates()).resolves.toBe(false);
    expect(getAppState().updater).toMatchObject({
      status: "error",
      errorMessage: "Error: offline",
      dialogOpen: false,
      availableVersion: null,
      currentVersion: null,
      releaseDate: null,
      releaseNotes: null,
      requiresManualInstall: false,
      manualInstallerUrl: null,
      manualInstallerSignatureUrl: null,
      offeredChannel: null,
      upToDateConfirmed: false,
    });
    expect(updaterMock.closeAvailableUpdate).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenLastCalledWith("set_menu_icon", {
      variant: "default",
    });
  });

  it("does not reopen or install a cached offer while a new check owns the handle", async () => {
    const { openUpdateDialog, installAvailableUpdate } =
      await import("./updater.actions");
    updaterMock.hasAvailableUpdate.mockReturnValue(true);
    let rejectCheck!: (error: Error) => void;
    updaterMock.checkForUpdate.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCheck = reject;
      }),
    );
    const checking = checkForAppUpdates();
    const opening = openUpdateDialog();
    await installAvailableUpdate();
    expect(getAppState().updater.dialogOpen).toBe(false);
    expect(updaterMock.installAvailableUpdate).not.toHaveBeenCalled();
    rejectCheck(new Error("offline"));
    await Promise.all([checking, opening]);
    expect(getAppState().updater.dialogOpen).toBe(false);
    expect(updaterMock.closeAvailableUpdate).toHaveBeenCalledOnce();
  });

  it("confirms up-to-date only for a user-initiated check", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(null);

    await checkForAppUpdates();
    expect(getAppState().updater.upToDateConfirmed).toBe(false);

    await checkForAppUpdates({ userInitiated: true });
    expect(getAppState().updater.upToDateConfirmed).toBe(true);
  });

  it("clears a stale up-to-date confirmation when an update appears", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(null);
    await checkForAppUpdates({ userInitiated: true });
    expect(getAppState().updater.upToDateConfirmed).toBe(true);

    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);
    const available = await checkForAppUpdates();

    expect(available).toBe(true);
    const { upToDateConfirmed, availableVersion, status } =
      getAppState().updater;
    expect(upToDateConfirmed).toBe(false);
    expect(availableVersion).toBe("0.1.7");
    expect(status).toBe("ready");
  });

  it("respects an active snooze for a background check", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);
    setAppState((state) => {
      state.updater.dismissedUntil = Date.now() + 60_000;
      return state;
    });

    await checkForAppUpdates();

    expect(getAppState().updater.dialogOpen).toBe(false);
  });

  it("opens the dialog inside a snooze when the user asked", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);
    setAppState((state) => {
      state.updater.dismissedUntil = Date.now() + 60_000;
      return state;
    });

    await checkForAppUpdates({ userInitiated: true });

    expect(getAppState().updater.dialogOpen).toBe(true);
  });

  it("does not toast for a user-initiated check", async () => {
    // The Settings section already shows the result inline; a background
    // check is the only one that needs to interrupt.
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);

    await checkForAppUpdates({ userInitiated: true });

    expect(toastMock.showToast).not.toHaveBeenCalled();
  });

  it("lights the tray badge when an update is found", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);

    await checkForAppUpdates();

    expect(invokeMock).toHaveBeenCalledWith("set_menu_icon", {
      variant: "update",
    });
  });

  it("clears the tray badge for a manual check that finds nothing", async () => {
    // Regression guard: the badge used to be driven only by the background
    // poll, so a manual check left a stale badge for up to six hours.
    updaterMock.checkForUpdate.mockResolvedValue(null);

    await checkForAppUpdates({ userInitiated: true });

    expect(invokeMock).toHaveBeenCalledWith("set_menu_icon", {
      variant: "default",
    });
  });

  it("survives a tray badge update that rejects", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no tray"));
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);

    await expect(checkForAppUpdates()).resolves.toBe(true);
  });

  it("coalesces concurrent checks into a single endpoint call", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);

    const [first, second] = await Promise.all([
      checkForAppUpdates(),
      checkForAppUpdates(),
    ]);

    expect(updaterMock.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("honors a user-initiated caller that joins a pending background check", async () => {
    // Regression: a manual "Check now" that joined an in-flight background
    // check was treated as background itself, so an available update inside a
    // snooze never opened the dialog. The shared result must use the combined
    // intent of every caller.
    let resolveCheck: ((value: typeof availableUpdate) => void) | undefined;
    updaterMock.checkForUpdate.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    setAppState((state) => {
      state.updater.dismissedUntil = Date.now() + 60_000;
      return state;
    });

    const background = checkForAppUpdates();
    const manual = checkForAppUpdates({ userInitiated: true });

    // Let both callers settle against the shared endpoint promise.
    resolveCheck!(availableUpdate);
    await Promise.all([background, manual]);

    expect(updaterMock.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(getAppState().updater.dialogOpen).toBe(true);
    expect(toastMock.showToast).not.toHaveBeenCalled();
  });
});

describe("checkForAppUpdates update channel", () => {
  it("checks stable by default and clears the channel badge", async () => {
    updaterMock.checkForUpdate.mockResolvedValue(null);

    await checkForAppUpdates();

    expect(updaterMock.checkForChannelUpdate).toHaveBeenCalledWith(
      "darwin",
      "stable",
    );
    expect(getAppState().updater.offeredChannel).toBeNull();
  });

  it("checks beta and badges it when beta is preferred", async () => {
    setAppState((state) => {
      state.userPrefs = {
        ...createDefaultPreferences(),
        updateChannel: "beta",
      };
      return state;
    });
    updaterMock.checkForUpdate.mockResolvedValue(availableUpdate);

    await checkForAppUpdates({ userInitiated: true });

    expect(updaterMock.checkForChannelUpdate).toHaveBeenCalledWith(
      "darwin",
      "beta",
    );
    expect(getAppState().updater.offeredChannel).toBe("beta");
    expect(getAppState().updater.availableVersion).toBe("0.1.7");
  });
});

const seedBeta = () =>
  setAppState((state) => ({
    ...state,
    userPrefs: { ...createDefaultPreferences(), updateChannel: "beta" },
  }));

describe("channel changes invalidate updater ownership", () => {
  it("releases an offered beta and checks stable after saving the preference", async () => {
    seedBeta();
    updaterMock.checkForUpdate.mockResolvedValueOnce(availableUpdate);
    await checkForAppUpdates();
    updaterMock.checkForUpdate.mockResolvedValueOnce(null);
    await setUpdateChannel("stable");
    expect(updaterMock.closeAvailableUpdate).toHaveBeenCalledOnce();
    expect(updaterMock.checkForChannelUpdate).toHaveBeenLastCalledWith(
      "darwin",
      "stable",
    );
    expect(getAppState().updater).toMatchObject({
      availableVersion: null,
      offeredChannel: null,
      dialogOpen: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith("set_menu_icon", {
      variant: "default",
    });
  });
  it.each([false, true])(
    "ignores a late beta check result/error and rechecks the newly saved channel (error=%s)",
    async (reject) => {
      seedBeta();
      let finish!: (value: typeof availableUpdate) => void;
      let fail!: (error: Error) => void;
      updaterMock.checkForUpdate.mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
      );
      const previous = checkForAppUpdates();
      updaterMock.checkForUpdate.mockResolvedValueOnce({
        ...availableUpdate,
        version: "0.1.8",
      });
      const change = setUpdateChannel("stable");
      try {
        await vi.waitFor(() =>
          expect(getAppState().userPrefs?.updateChannel).toBe("stable"),
        );
      } finally {
        if (reject) fail(new Error("obsolete beta check failure"));
        else finish(availableUpdate);
      }
      const [oldResult] = await Promise.all([previous, change]);
      expect(oldResult).toBe(false);
      expect(updaterMock.checkForChannelUpdate).toHaveBeenLastCalledWith(
        "darwin",
        "stable",
      );
      expect(getAppState().updater).toMatchObject({
        status: "ready",
        availableVersion: "0.1.8",
        offeredChannel: "stable",
        errorMessage: null,
      });
    },
  );
  it("does not discard an offer or switch endpoints when saving the channel fails", async () => {
    seedBeta();
    updaterMock.checkForUpdate.mockResolvedValueOnce(availableUpdate);
    await checkForAppUpdates();
    const failure = new Error("preference write failed");
    savePreferences.mockRejectedValueOnce(failure);
    await expect(setUpdateChannel("stable")).rejects.toBe(failure);
    expect(getAppState().updater.offeredChannel).toBe("beta");
    expect(updaterMock.closeAvailableUpdate).not.toHaveBeenCalled();
    expect(updaterMock.checkForChannelUpdate).toHaveBeenCalledOnce();
  });
  it("refuses to install a retained offer from a different channel", async () => {
    seedBeta();
    updaterMock.checkForUpdate.mockResolvedValueOnce(availableUpdate);
    await checkForAppUpdates();
    setAppState((state) => ({
      ...state,
      userPrefs: createDefaultPreferences(),
    }));
    updaterMock.hasAvailableUpdate.mockReturnValue(true);
    updaterMock.checkForUpdate.mockResolvedValueOnce(null);
    const { installAvailableUpdate } = await import("./updater.actions");
    await installAvailableUpdate();
    expect(updaterMock.installAvailableUpdate).not.toHaveBeenCalled();
    expect(updaterMock.checkForChannelUpdate).toHaveBeenLastCalledWith(
      "darwin",
      "stable",
    );
    expect(getAppState().updater.availableVersion).toBeNull();
  });
  it("does not close the handle of an installation already in progress", async () => {
    seedBeta();
    setAppState((state) => ({
      ...state,
      updater: {
        ...state.updater,
        status: "downloading",
        offeredChannel: "beta",
      },
    }));
    await setUpdateChannel("stable");
    expect(updaterMock.closeAvailableUpdate).not.toHaveBeenCalled();
    expect(updaterMock.checkForChannelUpdate).not.toHaveBeenCalled();
    expect(getAppState().updater.status).toBe("downloading");
  });
});
