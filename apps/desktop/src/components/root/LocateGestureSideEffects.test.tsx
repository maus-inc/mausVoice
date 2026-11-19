// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import type { PillLocateGestureModifier } from "@maus-inc/types";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { LocateGestureSideEffects } from "./LocateGestureSideEffects";

ensureUiHarness();

const setKeys = (keys: string[]) =>
  act(() => {
    produceAppState((draft) => {
      draft.keysHeld = keys;
    });
  });

const setModifier = (modifier: PillLocateGestureModifier) =>
  act(() => {
    produceAppState((draft) => {
      draft.hotkeyStrategy = "listener";
      draft.userPrefs = {
        pillLocateGestureModifier: modifier,
      } as typeof draft.userPrefs;
    });
  });

const doubleTap = (key: string, now: number[]) => {
  const spy = vi.spyOn(performance, "now");
  for (const value of now) spy.mockReturnValueOnce(value);
  setKeys([key]);
  setKeys([]);
  setKeys([key]);
  setKeys([]);
  spy.mockRestore();
};

describe("LocateGestureSideEffects", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invoke.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    act(() => root.render(createElement(LocateGestureSideEffects)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("sends one locate message for the selected modifier", () => {
    setModifier("alt");
    doubleTap("Alt", [0, 80, 200, 280]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("sync_native_pill_assistant", {
      payload: JSON.stringify({ type: "locate" }),
    });
  });

  it("does not send for a different modifier", () => {
    setModifier("shift");
    doubleTap("Alt", [0, 80, 200, 280]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not send while the gesture is disabled", () => {
    setModifier("none");
    doubleTap("Alt", [0, 80, 200, 280]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not send on the Wayland bridge strategy", () => {
    setModifier("alt");
    act(() => {
      produceAppState((draft) => {
        draft.hotkeyStrategy = "bridge";
      });
    });
    doubleTap("Alt", [0, 80, 200, 280]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
