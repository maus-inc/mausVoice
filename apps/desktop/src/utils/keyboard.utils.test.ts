import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  getStyleSwitchActionNamesForKey,
  OPEN_CHAT_HOTKEY,
  syncHotkeyCombosToNative,
} from "./keyboard.utils";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

type Deferred = {
  promise: Promise<unknown>;
  resolve: () => void;
};

const defer = (): Deferred => {
  let resolvePromise!: () => void;
  const promise = new Promise<unknown>((resolve) => {
    resolvePromise = () => resolve(undefined);
  });
  return { promise, resolve: resolvePromise };
};

const setHotkeyCombo = (keys: string[]) => {
  setAppState({
    ...INITIAL_APP_STATE,
    hotkeyStrategy: "listener",
    hotkeyById: {
      h1: { id: "h1", actionName: OPEN_CHAT_HOTKEY, keys },
    },
  });
};

type SyncInvokeArgs = [string, { combos: string[][] }];

const syncCalls = (): SyncInvokeArgs[] =>
  invokeMock.mock.calls.filter(
    ([cmd]) => cmd === "sync_hotkey_combos",
  ) as SyncInvokeArgs[];

describe("syncHotkeyCombosToNative", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setHotkeyCombo(["ControlLeft", "KeyO"]);
  });

  it("serializes overlapping calls so an older snapshot can never land last", async () => {
    const first = defer();
    const events: string[] = [];
    let invokeCount = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "sync_hotkey_combos") {
        return Promise.resolve(undefined);
      }
      invokeCount += 1;
      const current = invokeCount;
      events.push(`start${current}`);
      const gate = current === 1 ? first.promise : Promise.resolve(undefined);
      return gate.then(() => {
        events.push(`end${current}`);
      });
    });

    // First sync starts and parks inside the native invoke.
    const p1 = syncHotkeyCombosToNative();
    await Promise.resolve();
    expect(events).toEqual(["start1"]);

    // Second sync is requested while the state is still v1...
    const p2 = syncHotkeyCombosToNative();
    expect(events).toEqual(["start1"]);

    // ...then the state moves on to v2 before the first sync finishes.
    setHotkeyCombo(["ControlLeft", "KeyP"]);
    first.resolve();
    await p1;
    await p2;

    // Strictly serial: the queued run starts only after the previous one
    // fully finished, and it applies the state current at execution time —
    // not the stale snapshot from when it was requested.
    expect(events).toEqual(["start1", "end1", "start2", "end2"]);
    const calls = syncCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][1].combos).toContainEqual(["ControlLeft", "KeyO"]);
    expect(calls[1][1].combos).toContainEqual(["ControlLeft", "KeyP"]);
  });

  it("keeps the queue alive when a sync's native invoke fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let failedFirstSync = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "sync_hotkey_combos") {
        return Promise.resolve(undefined);
      }
      if (!failedFirstSync) {
        failedFirstSync = true;
        return Promise.reject(new Error("native bridge down"));
      }
      return Promise.resolve(undefined);
    });

    // The failure must reach this caller (run rejects), not be swallowed by
    // the queue-keeping catch.
    await expect(syncHotkeyCombosToNative()).rejects.toThrow(
      "native bridge down",
    );
    setHotkeyCombo(["ControlLeft", "KeyP"]);
    await syncHotkeyCombosToNative();

    const calls = syncCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1][1].combos).toContainEqual(["ControlLeft", "KeyP"]);
    errorSpy.mockRestore();
  });
});

describe("getStyleSwitchActionNamesForKey", () => {
  it("maps a released physical key to its bound style-switch actions", () => {
    const state = {
      ...INITIAL_APP_STATE,
      hotkeyById: {
        fwd: {
          id: "fwd",
          actionName: "switch-writing-style-forward",
          keys: ["RightArrow"],
        },
        bwd: {
          id: "bwd",
          actionName: "switch-writing-style-backward",
          keys: ["LeftArrow"],
        },
        casual: {
          id: "casual",
          actionName: "switch-to-style:casual",
          keys: ["KeyC"],
        },
        futureStyleAction: {
          id: "future-style-action",
          actionName: "switch-writing-style-custom",
          keys: ["KeyF"],
        },
        chat: {
          id: "chat",
          actionName: OPEN_CHAT_HOTKEY,
          keys: ["KeyO"],
        },
      },
    };

    expect(getStyleSwitchActionNamesForKey(state, "RightArrow")).toEqual([
      "switch-writing-style-forward",
    ]);
    expect(getStyleSwitchActionNamesForKey(state, "KeyC")).toEqual([
      "switch-to-style:casual",
    ]);
    // Actions added under an existing shared prefix must also be releasable.
    expect(getStyleSwitchActionNamesForKey(state, "KeyF")).toEqual([
      "switch-writing-style-custom",
    ]);
    // A non-style action bound to a key must never be released as a style key.
    expect(getStyleSwitchActionNamesForKey(state, "KeyO")).toEqual([]);
    // A key with no binding resolves to nothing.
    expect(getStyleSwitchActionNamesForKey(state, "KeyZ")).toEqual([]);
  });

  it("is case-insensitive about the physical key", () => {
    const state = {
      ...INITIAL_APP_STATE,
      hotkeyById: {
        fwd: {
          id: "fwd",
          actionName: "switch-writing-style-forward",
          keys: ["RightArrow"],
        },
      },
    };
    expect(getStyleSwitchActionNamesForKey(state, "rightarrow")).toEqual([
      "switch-writing-style-forward",
    ]);
  });
});
