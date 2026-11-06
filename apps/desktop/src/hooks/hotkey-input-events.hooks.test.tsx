// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  evaluate: vi.fn(() => ({ allowed: true, reason: "ok" })),
  release: vi.fn(),
  actionsForKey: vi.fn((_state: unknown, _key: string) => ["cycle-style"]),
  logger: { verbose: vi.fn() },
}));
vi.mock("../utils/hotkey-filter.utils", () => ({
  evaluateHotkeyTrigger: mocks.evaluate,
  releaseHotkey: mocks.release,
}));
vi.mock("../utils/keyboard.utils", () => ({
  getStyleSwitchActionNamesForKey: mocks.actionsForKey,
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (event: string, listener: (payload: never) => void) =>
    mocks.listeners.set(event, listener),
}));
import { useHotkeyInputEvents } from "./hotkey-input-events.hooks";

const Probe = ({ main }: { main: boolean }) => {
  useHotkeyInputEvents(main);
  return null;
};

describe("native hotkey event ownership", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.evaluate.mockReturnValue({ allowed: true, reason: "ok" });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });

  it("releases only the physical style key while another key stays held", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    const held = mocks.listeners.get("keys_held")!;
    held({ keys: ["Control", "ArrowLeft"] } as never);
    held({ keys: ["control"] } as never);
    expect(mocks.actionsForKey).toHaveBeenCalledTimes(1);
    expect(mocks.actionsForKey.mock.calls[0][1]).toBe("ArrowLeft");
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith("cycle-style");
    expect(getAppState().keysHeld).toEqual(["control"]);
  });

  it("ignores held keys in a secondary window", async () => {
    await act(async () => root.render(createElement(Probe, { main: false })));
    mocks.listeners.get("keys_held")?.({ keys: ["Control"] } as never);
    expect(getAppState().keysHeld).toEqual([]);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("increments only allowed bridge events and supplies the live recording phase", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    setAppState({ overlayPhase: "recording" });
    const trigger = mocks.listeners.get("bridge_hotkey_trigger")!;
    trigger({ hotkey: "dictate" } as never);
    expect(mocks.evaluate).toHaveBeenCalledWith("dictate", true);
    expect(getAppState().hotkeyTriggers.dictate).toBe(1);
    mocks.evaluate.mockReturnValue({ allowed: false, reason: "repeat" });
    trigger({ hotkey: "dictate" } as never);
    expect(getAppState().hotkeyTriggers.dictate).toBe(1);
  });
});
