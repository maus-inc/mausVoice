// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
}));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (event: string, listener: (payload: never) => void) =>
    mocks.listeners.set(event, listener),
}));
import { useOverlayStateEvents } from "./overlay-state-events.hooks";

const Probe = () => {
  useOverlayStateEvents();
  return null;
};

describe("overlay event synchronization", () => {
  let root: Root;
  beforeEach(() => {
    mocks.listeners.clear();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });
  it("sanitizes non-finite audio levels and clears them outside recording", async () => {
    await act(async () => root.render(createElement(Probe)));
    const levels = mocks.listeners.get("recording_level")!;
    const phase = mocks.listeners.get("overlay_phase")!;
    phase({ phase: "recording" } as never);
    levels({ levels: [0.5, NaN, Infinity, "bad", -0.1] } as never);
    expect(getAppState().audioLevels).toEqual([0.5, 0, 0, 0, -0.1]);
    phase({ phase: "loading" } as never);
    expect(getAppState().overlayPhase).toBe("loading");
    expect(getAppState().audioLevels).toEqual([]);
    levels({ levels: "bad" } as never);
    expect(getAppState().audioLevels).toEqual([]);
  });
});
