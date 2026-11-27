import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import type { KeyboardListenerHealth } from "../state/app.state";
import {
  getDefaultHotkeyCombosForAction,
  getHotkeyCombosForAction,
  getKeycapLegend,
  getPrettyKeyName,
  getStyleSwitchActionNamesForKey,
  globalKeyStreamIsLive,
  listenerDeliversKeys,
  listenerIsProvenHealthy,
  seedListenerHealth,
  DICTATE_HOTKEY,
  OPEN_CHAT_HOTKEY,
  syncHotkeyCombosToNative,
} from "./keyboard.utils";

const { invokeMock, getPlatformMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getPlatformMock: vi.fn(() => "linux"),
}));
vi.mock("./platform.utils", () => ({ getPlatform: getPlatformMock }));

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

describe("getPrettyKeyName", () => {
  it.each([
    ["MetaLeft", "⊞ L"],
    ["MetaRight", "⊞ R"],
    ["ControlLeft", "Ctrl L"],
    ["ControlRight", "Ctrl R"],
    ["ShiftLeft", "Shift L"],
    ["ShiftRight", "Shift R"],
    ["AltLeft", "Alt L"],
    ["AltRight", "Alt R"],
    ["OptionLeft", "Alt L"],
    ["KeyA", "A"],
    ["Escape", "Escape"],
    ["LeftArrow", "←"],
    ["RightArrow", "→"],
    ["UpArrow", "↑"],
    ["DownArrow", "↓"],
  ])("renders %s as %s", (input, expected) => {
    expect(getPrettyKeyName(input)).toBe(expected);
  });

  it("preserves side suffix on bare Meta* without a side", () => {
    expect(getPrettyKeyName("Meta")).toBe("⊞");
  });
});

describe("getKeycapLegend", () => {
  it("uses compact bundled-font labels for Space and Meta", () => {
    expect(getKeycapLegend("Space")).toEqual({ label: "SPC" });
    expect(getKeycapLegend("Meta")).toEqual({ label: "Win" });
  });

  it("uses bundled-font modifier labels on macOS without changing accessible names", () => {
    getPlatformMock.mockReturnValueOnce("macos");
    expect(getKeycapLegend("MetaLeft")).toEqual({
      label: "Cmd",
      sublabel: "Left",
    });
    getPlatformMock.mockReturnValueOnce("macos");
    expect(getKeycapLegend("AltRight")).toEqual({
      label: "Alt",
      sublabel: "Right",
    });
    getPlatformMock.mockReturnValueOnce("macos");
    expect(getKeycapLegend("ControlLeft")).toEqual({
      label: "Ctrl",
      sublabel: "Left",
    });
    getPlatformMock.mockReturnValueOnce("macos");
    expect(getPrettyKeyName("MetaLeft")).toBe("⌘ L");
  });

  it.each([
    ["ShiftLeft", "⇧", "Left"],
    ["ShiftRight", "⇧", "Right"],
    ["ControlLeft", "Ctrl", "Left"],
    ["AltRight", "Alt", "Right"],
    ["OptionLeft", "Alt", "Left"],
    ["MetaRight", "Win", "Right"],
  ])("stacks %s as %s over %s", (input, label, sublabel) => {
    expect(getKeycapLegend(input)).toEqual({ label, sublabel });
  });

  it.each([
    "KeyA",
    "LeftArrow",
    "ArrowLeft",
    "CustomRight",
    "constructor",
    "__proto__",
  ])("leaves %s as a single line", (input) => {
    expect(getKeycapLegend(input)).toEqual({
      label: getPrettyKeyName(input),
    });
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
    expect(getStyleSwitchActionNamesForKey(state, "KeyF")).toEqual([
      "switch-writing-style-custom",
    ]);
    expect(getStyleSwitchActionNamesForKey(state, "KeyO")).toEqual([]);
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

/**
 * The platform is mocked as Linux for this file, which is the case the table
 * used to answer with nothing at all.
 */
describe("default hotkeys", () => {
  it("does not restore a platform default after an explicit clear", async () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.onboarding.dictationOverrideEnabled = true;
    state.hotkeyStrategy = "bridge";
    state.hotkeyById.cleared = {
      id: "cleared",
      actionName: DICTATE_HOTKEY,
      keys: [],
    };
    state.settings.hotkeyIds = ["cleared"];
    expect(getHotkeyCombosForAction(state, DICTATE_HOTKEY)).toEqual([]);
    setAppState(state, true);
    invokeMock.mockReset().mockResolvedValue(undefined);
    await syncHotkeyCombosToNative();
    expect(invokeMock).toHaveBeenCalledWith("sync_compositor_hotkeys", {
      bindings: [],
    });
  });

  it("keeps additional configured shortcuts when the primary is cleared", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.hotkeyById = {
      primary: { id: "primary", actionName: DICTATE_HOTKEY, keys: [] },
      extra: { id: "extra", actionName: DICTATE_HOTKEY, keys: ["KeyA"] },
    };
    expect(getHotkeyCombosForAction(state, DICTATE_HOTKEY)).toEqual([["KeyA"]]);
  });
  it("binds the dictate key on Linux, and not only on macOS", () => {
    expect(getDefaultHotkeyCombosForAction(DICTATE_HOTKEY)).toEqual([
      ["ControlLeft", "AltLeft", "Space"],
    ]);
  });

  it("sends the default dictation binding to the Wayland compositor bridge", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    setAppState(
      {
        ...structuredClone(INITIAL_APP_STATE),
        hotkeyStrategy: "bridge",
        onboarding: {
          ...INITIAL_APP_STATE.onboarding,
          dictationOverrideEnabled: true,
        },
      },
      true,
    );
    await syncHotkeyCombosToNative();
    expect(invokeMock).toHaveBeenCalledWith("sync_compositor_hotkeys", {
      bindings: expect.arrayContaining([
        {
          actionName: DICTATE_HOTKEY,
          keys: ["ControlLeft", "AltLeft", "Space"],
        },
      ]),
    });
  });

  it("leaves an action with no default unbound", () => {
    // Nothing ships a key for this one: an empty list is the honest answer, and
    // is what a row with no binding shows as "Not set".
    expect(getDefaultHotkeyCombosForAction(OPEN_CHAT_HOTKEY)).toEqual([]);
  });
});

/**
 * Every health state the native listener reports, each with the answer to the
 * two questions the renderer asks about it. A table rather than one assertion
 * per state, so a state added to `KeyboardListenerHealth` without an answer
 * here fails the exhaustiveness check below instead of quietly falling through.
 */
const HEALTH_CASES: Array<{
  health: KeyboardListenerHealth;
  delivering: boolean;
  proven: boolean;
}> = [
  { health: "starting", delivering: false, proven: false },
  { health: "connected", delivering: true, proven: false },
  { health: "healthy_grab", delivering: true, proven: true },
  { health: "grab_failed", delivering: false, proven: false },
  { health: "fallback_starting", delivering: true, proven: false },
  { health: "degraded_listen_fallback", delivering: true, proven: true },
  { health: "failed", delivering: false, proven: false },
  { health: "stopped", delivering: false, proven: false },
];

describe("listener health predicates", () => {
  it("answers every health state", () => {
    for (const { health, delivering, proven } of HEALTH_CASES) {
      expect({ health, delivering: listenerDeliversKeys(health) }).toEqual({
        health,
        delivering,
      });
      expect({ health, proven: listenerIsProvenHealthy(health) }).toEqual({
        health,
        proven,
      });
    }
  });

  it("counts a live but unproven listener as delivering keys", () => {
    // `connected` and `fallback_starting` are the grace window after a child
    // arrives. The child is publishing snapshots there; only the proof that the
    // path stays alive is missing, which is why a gesture must not wait for it.
    expect(listenerDeliversKeys("connected")).toBe(true);
    expect(listenerDeliversKeys("fallback_starting")).toBe(true);
  });

  it("asks for proof before a failure episode is treated as over", () => {
    // The failure notice resets on these two only. `connected` is reported by
    // the same child that may die inside the grace window, so resetting there
    // would re-notify on every flap of a listener that cannot stay up.
    expect(listenerIsProvenHealthy("connected")).toBe(false);
    expect(listenerIsProvenHealthy("fallback_starting")).toBe(false);
  });
});

describe("globalKeyStreamIsLive", () => {
  it("needs the listener strategy, because the bridge publishes no key stream", () => {
    // macOS, Windows and Linux X11 report `listener`. A Wayland session reports
    // `bridge`, where the compositor hands over registerable chords and no
    // stream of held keys, so no gesture can be detected from it.
    expect(globalKeyStreamIsLive("listener", "healthy_grab")).toBe(true);
    expect(globalKeyStreamIsLive("bridge", "healthy_grab")).toBe(false);
    expect(globalKeyStreamIsLive(null, "healthy_grab")).toBe(false);
  });

  it("needs a listener that is delivering, not merely configured", () => {
    // A revoked accessibility permission stops the listener. The strategy still
    // reads `listener`, and offering the gesture then would be a lie.
    for (const health of [
      "starting",
      "grab_failed",
      "failed",
      "stopped",
    ] as const) {
      expect({
        health,
        live: globalKeyStreamIsLive("listener", health),
      }).toEqual({ health, live: false });
    }
  });

  it("stays live through the states Windows passes on the way to healthy", () => {
    // Windows restarts the listener on resume, on session unlock and across the
    // elevation relaunch, so these two states are routine there rather than
    // momentary. Hiding the gesture's settings row in them is what made it look
    // absent on Windows.
    for (const health of ["connected", "fallback_starting"] as const) {
      expect(globalKeyStreamIsLive("listener", health)).toBe(true);
    }
  });
});

describe("seedListenerHealth", () => {
  it("applies the snapshot when no health event landed during the read", async () => {
    const applied: KeyboardListenerHealth[] = [];

    await seedListenerHealth(
      () => Promise.resolve("starting"),
      () => false,
      (health) => applied.push(health),
    );

    expect(applied).toEqual(["starting"]);
  });

  it("drops the snapshot when a health event landed while it was pending", async () => {
    // The event is newer than the snapshot, and Rust does not repeat an
    // unchanged state, so writing the older value back would strand the store on
    // a state the listener has already left.
    const applied: KeyboardListenerHealth[] = [];
    let release: (health: KeyboardListenerHealth) => void = () => {};
    let eventApplied = false;
    const pending = seedListenerHealth(
      () =>
        new Promise<KeyboardListenerHealth>((resolve) => {
          release = resolve;
        }),
      () => eventApplied,
      (health) => applied.push(health),
    );

    eventApplied = true;
    release("starting");
    await pending;

    expect(applied).toEqual([]);
  });

  it("asks about newer events at the write, not only after the read", async () => {
    // The guard and the write share one synchronous block, so an event that
    // landed after the read resolved is still respected.
    const applied: KeyboardListenerHealth[] = [];

    await seedListenerHealth(
      () => Promise.resolve("connected"),
      () => true,
      (health) => applied.push(health),
    );

    expect(applied).toEqual([]);
  });

  it("propagates a failed read instead of seeding a guess", async () => {
    const applied: KeyboardListenerHealth[] = [];

    await expect(
      seedListenerHealth(
        () => Promise.reject(new Error("listener not running")),
        () => false,
        (health) => applied.push(health),
      ),
    ).rejects.toThrow("listener not running");
    expect(applied).toEqual([]);
  });
});
