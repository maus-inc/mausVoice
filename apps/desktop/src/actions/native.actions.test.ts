import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const { nativeRepoMock, snackbarMock, loggerMock } = vi.hoisted(() => {
  const nativeRepoMock = {
    requestAdminRelaunch: vi.fn(),
    quitApp: vi.fn(async () => undefined),
  };
  const snackbarMock = {
    showErrorSnackbar: vi.fn(),
  };
  const loggerMock = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  };
  return { nativeRepoMock, snackbarMock, loggerMock };
});

vi.mock("../repos", () => ({
  getNativeRepo: () => nativeRepoMock,
}));

vi.mock("./app.actions", () => snackbarMock);

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

vi.mock("../i18n", () => ({
  getIntl: () => ({
    formatMessage: (descriptor: { defaultMessage: string }) =>
      descriptor.defaultMessage,
  }),
}));

const { requestAdminRelaunch, quitApp } = await import("./native.actions");

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

afterEach(() => {
  vi.clearAllMocks();
  resetState();
});

describe("requestAdminRelaunch", () => {
  it("opens the elevation-declined dialog on cancelled without releasing the startup gate", async () => {
    nativeRepoMock.requestAdminRelaunch.mockResolvedValueOnce("cancelled");

    // Simulate the pre-flight gate still holding full init.
    setAppState({
      settings: {
        ...getAppState().settings,
        elevationStartupPending: true,
        elevationDeclinedDialogOpen: false,
      },
    });

    const result = await requestAdminRelaunch();

    expect(result).toBe("cancelled");
    expect(getAppState().settings.elevationDeclinedDialogOpen).toBe(true);
    // Gate stays pending so the decline dialog is the helper's final state
    // until the user chooses Launch normally or Close mausVoice.
    expect(getAppState().settings.elevationStartupPending).toBe(true);
  });

  it("returns success without opening the dialog when already elevated", async () => {
    nativeRepoMock.requestAdminRelaunch.mockResolvedValueOnce("success");

    const result = await requestAdminRelaunch();

    expect(result).toBe("success");
    expect(getAppState().settings.elevationDeclinedDialogOpen).toBe(false);
  });

  it("surfaces a snackbar and returns failed without opening the dialog", async () => {
    nativeRepoMock.requestAdminRelaunch.mockResolvedValueOnce("failed");

    const result = await requestAdminRelaunch();

    expect(result).toBe("failed");
    expect(getAppState().settings.elevationDeclinedDialogOpen).toBe(false);
    expect(snackbarMock.showErrorSnackbar).toHaveBeenCalled();
  });

  it("returns null and snackbars when the invoke throws", async () => {
    nativeRepoMock.requestAdminRelaunch.mockRejectedValueOnce(
      new Error("ipc down"),
    );

    const result = await requestAdminRelaunch();

    expect(result).toBeNull();
    expect(snackbarMock.showErrorSnackbar).toHaveBeenCalled();
    expect(getAppState().settings.elevationDeclinedDialogOpen).toBe(false);
  });
});

describe("quitApp", () => {
  it("delegates to the native quit command", async () => {
    await quitApp();
    expect(nativeRepoMock.quitApp).toHaveBeenCalledTimes(1);
  });

  it("snackbars when quit fails without throwing", async () => {
    nativeRepoMock.quitApp.mockRejectedValueOnce(new Error("nope"));
    await expect(quitApp()).resolves.toBeUndefined();
    expect(snackbarMock.showErrorSnackbar).toHaveBeenCalled();
  });
});
