// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import type { PillLocateGestureModifier } from "@maus-inc/types";
import {
  INITIAL_APP_STATE,
  type KeyboardListenerHealth,
} from "../../state/app.state";
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

/**
 * Selects a modifier on a delivering listener, which is the configuration the
 * settings row offers. `connected` on purpose: it is the state a Windows
 * listener sits in for the grace window after every connect, and a tap there is
 * still a tap.
 */
const setModifier = (
  modifier: PillLocateGestureModifier,
  health: KeyboardListenerHealth = "connected",
) =>
  act(() => {
    produceAppState((draft) => {
      draft.hotkeyStrategy = "listener";
      draft.keyboardListenerHealth = health;
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

  it("drops the sequence when the modifier changes while the key is held", () => {
    // Alt pressed, released, pressed again; the preference then moves to shift
    // before Alt comes up. The release must not complete the stored Alt pair.
    const spy = vi.spyOn(performance, "now");
    // One reading per store update, in order: select alt, press, release,
    // press, switch to shift, release. Every reading must sit inside the
    // double-tap window, or the release would be dropped as a long hold and
    // the test would pass for the wrong reason.
    for (const value of [0, 10, 80, 200, 280, 290]) {
      spy.mockReturnValueOnce(value);
    }
    setModifier("alt");
    setKeys(["Alt"]);
    setKeys([]);
    setKeys(["Alt"]);
    setModifier("shift");
    setKeys([]);

    spy.mockRestore();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not count a hold that spans a disabled window as a tap", () => {
    // Alt stays down while the gesture is switched off and on, so its release
    // never reports the hold's real start. That release must not seed a pair
    // for the short tap after it to complete.
    const spy = vi.spyOn(performance, "now");
    for (const value of [0, 10, 200, 280, 320, 380]) {
      spy.mockReturnValueOnce(value);
    }
    setModifier("alt");
    setKeys(["Alt"]);
    setModifier("none");
    setModifier("alt");
    setKeys([]);
    setKeys(["Alt"]);
    setKeys([]);
    spy.mockRestore();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends through the live-but-unproven state a Windows listener reports", () => {
    // `connected` is the grace window after the child connects. The child is
    // already publishing snapshots there, so a tap must count; waiting for the
    // proof that promotes the health state would drop it.
    setModifier("alt", "connected");
    doubleTap("Alt", [0, 80, 200, 280]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not send once the listener has stopped delivering", () => {
    for (const health of ["stopped", "failed"] as const) {
      invoke.mockClear();
      setModifier("alt", health);
      doubleTap("Alt", [0, 80, 200, 280]);
      expect({ health, sent: invoke.mock.calls.length }).toEqual({
        health,
        sent: 0,
      });
    }
  });

  it("does not pair a tap that was held across a dead listener", () => {
    // A hold whose release is dropped must not seed the first tap of a pair:
    // the release is the only place a tap's length is known, and the listener
    // was not publishing snapshots when this one ended.
    const spy = vi.spyOn(performance, "now");
    for (const value of [0, 10, 200, 280, 320, 380]) {
      spy.mockReturnValueOnce(value);
    }
    setModifier("alt", "healthy_grab");
    setKeys(["Alt"]);
    setModifier("alt", "failed");
    setModifier("alt", "healthy_grab");
    setKeys([]);
    setKeys(["Alt"]);
    setKeys([]);
    spy.mockRestore();
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
