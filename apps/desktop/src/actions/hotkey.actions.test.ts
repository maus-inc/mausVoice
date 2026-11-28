import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hotkey } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../utils/local-data-write-gate";

const mocks = vi.hoisted(() => ({
  listHotkeys: vi.fn<() => Promise<Hotkey[]>>(),
  syncHotkeyCombosToNative: vi.fn<() => Promise<void>>(),
  showErrorSnackbar: vi.fn(),
}));

vi.mock("../repos", () => ({
  getHotkeyRepo: () => ({
    listHotkeys: mocks.listHotkeys,
  }),
}));

vi.mock("../utils/keyboard.utils", () => ({
  syncHotkeyCombosToNative: mocks.syncHotkeyCombosToNative,
}));

vi.mock("./app.actions", () => ({
  showErrorSnackbar: mocks.showErrorSnackbar,
}));

import { loadHotkeys } from "./hotkey.actions";

const sampleHotkey: Hotkey = {
  id: "hk-1",
  actionName: "dictation",
  keys: ["Control", "Space"],
};

describe("loadHotkeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncHotkeyCombosToNative.mockResolvedValue(undefined);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("loads hotkeys and syncs native combos when no clear intervenes", async () => {
    mocks.listHotkeys.mockResolvedValue([sampleHotkey]);

    await loadHotkeys();

    expect(getAppState().settings.hotkeysStatus).toBe("success");
    expect(getAppState().settings.hotkeyIds).toEqual(["hk-1"]);
    expect(getAppState().hotkeyById["hk-1"]).toEqual(sampleHotkey);
    expect(mocks.syncHotkeyCombosToNative).toHaveBeenCalledTimes(1);
  });

  it("drops stale hotkeys, skips native sync, and resets loading when local data is cleared mid-read", async () => {
    let resolveList!: (hotkeys: Hotkey[]) => void;
    mocks.listHotkeys.mockImplementation(
      () =>
        new Promise<Hotkey[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    const loading = loadHotkeys();
    expect(getAppState().settings.hotkeysStatus).toBe("loading");

    const releaseClear = await beginLocalDataClear();
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    releaseClear();

    resolveList([sampleHotkey]);
    await loading;

    expect(getAppState().settings.hotkeyIds).toEqual([]);
    expect(getAppState().hotkeyById["hk-1"]).toBeUndefined();
    expect(getAppState().settings.hotkeysStatus).toBe("idle");
    expect(getAppState().settings.hotkeysRequestId).toBeNull();
    expect(mocks.syncHotkeyCombosToNative).not.toHaveBeenCalled();
  });

  it("invalidates in-flight hotkey loads when Zustand state is reset", async () => {
    let resolveStale!: (hotkeys: Hotkey[]) => void;
    mocks.listHotkeys.mockImplementationOnce(
      () =>
        new Promise<Hotkey[]>((resolve) => {
          resolveStale = resolve;
        }),
    );

    const staleLoad = loadHotkeys();
    expect(getAppState().settings.hotkeysRequestId).not.toBeNull();

    setAppState(structuredClone(INITIAL_APP_STATE), true);
    expect(getAppState().settings.hotkeysRequestId).toBeNull();

    resolveStale([sampleHotkey]);
    await staleLoad;

    expect(getAppState().settings.hotkeyIds).toEqual([]);
    expect(getAppState().settings.hotkeysStatus).toBe("idle");
    expect(mocks.syncHotkeyCombosToNative).not.toHaveBeenCalled();
  });
});
