import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  pushPillPlacementToNative,
  restartKeyboardListenerOnResume,
} from "./windows-sync.actions";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("restartKeyboardListenerOnResume", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  it("restarts the listener when strategy is listener, main window, and authorized", async () => {
    await expect(
      restartKeyboardListenerOnResume({
        hotkeyStrategy: "listener",
        isMainWindow: true,
        keyPermAuthorized: true,
      }),
    ).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("restart_key_listener");
  });

  it("does nothing under the bridge strategy", async () => {
    await expect(
      restartKeyboardListenerOnResume({
        hotkeyStrategy: "bridge",
        isMainWindow: true,
        keyPermAuthorized: true,
      }),
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing while the strategy is still undetermined (null)", async () => {
    await expect(
      restartKeyboardListenerOnResume({
        hotkeyStrategy: null,
        isMainWindow: true,
        keyPermAuthorized: true,
      }),
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing from a non-main window", async () => {
    await expect(
      restartKeyboardListenerOnResume({
        hotkeyStrategy: "listener",
        isMainWindow: false,
        keyPermAuthorized: true,
      }),
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing when accessibility permission is not authorized", async () => {
    await expect(
      restartKeyboardListenerOnResume({
        hotkeyStrategy: "listener",
        isMainWindow: true,
        keyPermAuthorized: false,
      }),
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates an invoke rejection so the caller can log it", async () => {
    invokeMock.mockRejectedValueOnce(new Error("native listener unavailable"));
    await expect(
      restartKeyboardListenerOnResume({
        hotkeyStrategy: "listener",
        isMainWindow: true,
        keyPermAuthorized: true,
      }),
    ).rejects.toThrow("native listener unavailable");
  });
});

describe("pushPillPlacementToNative", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  it("pushes the persisted placement to the native pill process", async () => {
    await pushPillPlacementToNative("top");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("set_pill_placement", {
      placement: "top",
    });
  });

  it("pushes bottom too (explicit user choice, not just the default)", async () => {
    await pushPillPlacementToNative("bottom");
    expect(invokeMock).toHaveBeenCalledWith("set_pill_placement", {
      placement: "bottom",
    });
  });

  it("propagates a native rejection so the caller can log it", async () => {
    invokeMock.mockRejectedValueOnce(new Error("pill not reachable"));
    await expect(pushPillPlacementToNative("top")).rejects.toThrow(
      "pill not reachable",
    );
  });
});
