import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const { updaterMock, toastMock, invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
  updaterMock: {
    checkForUpdate: vi.fn(),
    hasAvailableUpdate: vi.fn(() => false),
    closeAvailableUpdate: vi.fn(async () => {}),
    installAvailableUpdate: vi.fn(async () => {}),
    downloadAndOpenMacInstaller: vi.fn(async () => {}),
    relaunchApp: vi.fn(async () => {}),
    isReadOnlyFilesystemInstallError: vi.fn(() => false),
  },
  toastMock: { showToast: vi.fn(async () => {}) },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@maus-inc/desktop-utils", () => updaterMock);
vi.mock("./toast.actions", () => toastMock);
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
});
