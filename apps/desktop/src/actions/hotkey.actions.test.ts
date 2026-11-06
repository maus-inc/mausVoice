import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState, useAppStore } from "../store";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  list: vi.fn(),
  sync: vi.fn(),
  showError: vi.fn(),
}));
vi.mock("../repos", () => ({
  getHotkeyRepo: () => ({ saveHotkey: mocks.save, listHotkeys: mocks.list }),
}));
vi.mock("../utils/keyboard.utils", () => ({
  syncHotkeyCombosToNative: mocks.sync,
}));
vi.mock("./app.actions", () => ({ showErrorSnackbar: mocks.showError }));

import { loadHotkeys, saveHotkey, savePrimaryHotkey } from "./hotkey.actions";

const hotkey = { id: "one", actionName: "dictate", keys: ["ControlLeft"] };

beforeEach(() => {
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.save.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
  mocks.sync.mockResolvedValue(undefined);
});

describe("loadHotkeys", () => {
  it("merges edits and deletions made while the read is pending", async () => {
    const old = { id: "old", actionName: "other", keys: ["A"] };
    const removed = { id: "removed", actionName: "other", keys: ["B"] };
    const stale = { id: "stale", actionName: "other", keys: ["C"] };
    setAppState({
      hotkeyById: { old, removed, stale },
      settings: {
        ...getAppState().settings,
        hotkeyIds: ["old", "removed", "stale"],
      },
    });
    let finish!: (value: (typeof old)[]) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = loadHotkeys();
    await saveHotkey({ ...old, keys: ["Q"] });
    setAppState((state) => ({
      hotkeyById: Object.fromEntries(
        Object.entries(state.hotkeyById).filter(([id]) => id !== "removed"),
      ),
      settings: {
        ...state.settings,
        hotkeyIds: state.settings.hotkeyIds.filter((id) => id !== "removed"),
      },
    }));
    finish([old, removed, { id: "fresh", actionName: "other", keys: ["D"] }]);
    await loading;
    expect(getAppState().hotkeyById).toEqual({
      old: { ...old, keys: ["Q"] },
      fresh: { id: "fresh", actionName: "other", keys: ["D"] },
    });
    expect(getAppState().settings.hotkeyIds).toEqual(["old", "fresh"]);
  });

  it("does not discard an optimistic edit when its persistence fails during a load", async () => {
    setAppState({
      hotkeyById: { one: hotkey },
      settings: { ...getAppState().settings, hotkeyIds: ["one"] },
    });
    let finish!: (value: (typeof hotkey)[]) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.save.mockRejectedValueOnce(new Error("disk failure"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const loading = loadHotkeys();
      await saveHotkey({ ...hotkey, keys: ["KeyQ"] });
      finish([hotkey]);
      await loading;
      expect(getAppState().hotkeyById.one.keys).toEqual(["KeyQ"]);
      expect(mocks.showError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not let an older load replace the latest result", async () => {
    let finish!: (value: (typeof hotkey)[]) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mocks.list.mockResolvedValueOnce([{ ...hotkey, keys: ["B"] }]);
    const first = loadHotkeys();
    await loadHotkeys();
    finish([hotkey]);
    await first;
    expect(getAppState().hotkeyById.one.keys).toEqual(["B"]);
  });
});

describe("saveHotkey", () => {
  it("registers optimistically before persisting and syncing, without duplicate ids", async () => {
    mocks.save.mockImplementation(async () => {
      expect(getAppState().hotkeyById.one).toEqual(hotkey);
      expect(getAppState().settings.hotkeyIds).toEqual(["one"]);
      expect(mocks.sync).toHaveBeenCalledTimes(
        mocks.save.mock.calls.length - 1,
      );
    });
    await saveHotkey(hotkey);
    await saveHotkey(hotkey);
    expect(getAppState().settings.hotkeyIds).toEqual(["one"]);
    expect(getAppState().settings.hotkeysStatus).toBe("idle");
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(mocks.showError).not.toHaveBeenCalled();
  });

  it.each(["save", "sync"] as const)(
    "reports a %s failure and retains the optimistic state",
    async (stage) => {
      mocks[stage].mockRejectedValueOnce(new Error("failure"));
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        await expect(saveHotkey(hotkey)).resolves.toBeUndefined();
        expect(getAppState().hotkeyById.one).toEqual(hotkey);
        expect(mocks.showError).toHaveBeenCalledWith(
          "Failed to save hotkey. Please try again.",
        );
        expect(mocks.sync).toHaveBeenCalledTimes(stage === "sync" ? 1 : 0);
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});

describe("savePrimaryHotkey", () => {
  it("waits for the persisted primary and preserves additional bindings", async () => {
    let finish!: (value: (typeof hotkey)[]) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const additional = { id: "two", actionName: "dictate", keys: ["B"] };
    const keys = ["Ctrl"];
    const first = savePrimaryHotkey("dictate", keys);
    const second = savePrimaryHotkey("dictate", ["Ctrl", "Q"]);
    keys.push("mutated while waiting");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.save).not.toHaveBeenCalled();
    finish([hotkey, additional]);
    await Promise.all([first, second]);
    expect(mocks.save.mock.calls.map(([item]) => item)).toEqual([
      { ...hotkey, keys: ["Ctrl"] },
      { ...hotkey, keys: ["Ctrl", "Q"] },
    ]);
    expect(getAppState().hotkeyById.two).toEqual(additional);
    expect(getAppState().settings.hotkeyIds).toEqual(["one", "two"]);
  });

  it("reuses one newly created id for concurrent primary edits", async () => {
    const first = savePrimaryHotkey("dictate", ["Ctrl"]);
    const second = savePrimaryHotkey("dictate", ["Ctrl", "Q"]);
    await Promise.all([first, second]);
    const [firstSave, secondSave] = mocks.save.mock.calls.map(([item]) => item);
    expect(firstSave.id).toBe(secondSave.id);
    expect(firstSave.keys).toEqual(["Ctrl"]);
    expect(secondSave.keys).toEqual(["Ctrl", "Q"]);
    expect(getAppState().settings.hotkeyIds).toEqual([firstSave.id]);
  });

  it("waits for a newer load if it replaces the one an edit was waiting for", async () => {
    let finishOld!: (value: (typeof hotkey)[]) => void;
    let finishNew!: (value: (typeof hotkey)[]) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
    const edit = savePrimaryHotkey("dictate", ["Q"]);
    const latest = loadHotkeys();
    finishOld([]);
    await Promise.resolve();
    expect(mocks.save).not.toHaveBeenCalled();
    finishNew([hotkey]);
    await Promise.all([edit, latest]);
    expect(mocks.save).toHaveBeenCalledWith({ ...hotkey, keys: ["Q"] });
  });

  it("does not wait forever for a superseded load that never settles", async () => {
    mocks.list.mockImplementationOnce(() => new Promise(() => {}));
    mocks.list.mockResolvedValueOnce([hotkey]);
    const edit = savePrimaryHotkey("dictate", ["Q"]);
    await loadHotkeys();
    await edit;
    expect(mocks.save).toHaveBeenCalledWith({ ...hotkey, keys: ["Q"] });
  });

  it("does not apply a delayed load or edit to a replacement auth session", async () => {
    let finish!: (value: (typeof hotkey)[]) => void;
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const edit = savePrimaryHotkey("dictate", ["Q"]);
    setAppState((state) => ({
      authSessionNonce: state.authSessionNonce + 1,
      settings: { ...state.settings, hotkeysStatus: "success" },
    }));
    finish([hotkey]);
    await edit;
    expect(mocks.save).not.toHaveBeenCalled();
    expect(getAppState().hotkeyById).toEqual({});
  });

  it("starts a fresh load for a new session even when the previous load hangs", async () => {
    mocks.list.mockImplementationOnce(() => new Promise(() => {}));
    mocks.list.mockResolvedValueOnce([hotkey]);
    const oldEdit = savePrimaryHotkey("dictate", ["old"]);
    setAppState((state) => ({ authSessionNonce: state.authSessionNonce + 1 }));
    const newEdit = savePrimaryHotkey("dictate", ["new"]);
    await Promise.all([oldEdit, newEdit]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith({ ...hotkey, keys: ["new"] });
  });

  it("publishes the pending load before notifying reentrant store subscribers", async () => {
    let edit: Promise<void> | undefined;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (!edit && state.settings.hotkeysStatus === "loading") {
        edit = savePrimaryHotkey("dictate", ["Q"]);
      }
    });
    try {
      mocks.list.mockResolvedValueOnce([hotkey]);
      await loadHotkeys();
      await edit;
      expect(mocks.list).toHaveBeenCalledTimes(1);
      expect(mocks.save).toHaveBeenCalledWith({ ...hotkey, keys: ["Q"] });
    } finally {
      unsubscribe();
    }
  });

  it("does not write a new primary if persisted hotkeys cannot be read", async () => {
    mocks.list.mockRejectedValueOnce(new Error("disk failed"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await savePrimaryHotkey("dictate", ["Q"]);
      expect(mocks.save).not.toHaveBeenCalled();
      expect(getAppState().settings.hotkeysStatus).toBe("error");
      expect(mocks.showError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
