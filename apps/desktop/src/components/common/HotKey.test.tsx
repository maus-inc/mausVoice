// @vitest-environment jsdom
import { isHotkeyCaptureActive } from "../../hooks/hotkey-capture.hooks";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

import { getAppState, setAppState } from "../../store";
import { HotKey } from "./HotKey";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let onChange: ReturnType<typeof vi.fn>;

const Recorder = () => {
  const [value, setValue] = useState(["KeyZ"]);
  return createElement(HotKey, {
    value,
    onChange: (keys: string[]) => {
      onChange(keys);
      setValue(keys);
    },
  });
};

const keys = (keysHeld: string[]) => act(() => setAppState({ keysHeld }));
const focus = () =>
  act(() => (container.firstElementChild as HTMLElement).focus());

beforeEach(() => {
  onChange = vi.fn();
  setAppState({
    keysHeld: [],
    hotkeyStrategy: "bridge",
    snackbarMessage: undefined,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(Recorder)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HotKey", () => {
  it("does not let an inactive sibling clear a focused capture", () => {
    focus();
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(Recorder),
          createElement(HotKey),
        ),
      ),
    );
    // The first recorder was replaced by the wrapper, so focus the new one.
    const first = container.querySelector<HTMLElement>("[tabindex='0']")!;
    act(() => first.focus());
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(Recorder),
          createElement(HotKey),
          createElement(HotKey),
        ),
      ),
    );
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    act(() => root.render(createElement("div", null, createElement(HotKey))));
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  });

  it("records the combination and accepts it on release", () => {
    focus();
    expect(isHotkeyCaptureActive(getAppState())).toBe(true);
    keys(["ControlLeft"]);
    keys(["ControlLeft", "KeyA"]);
    keys(["ControlLeft"]);
    expect(onChange.mock.calls).toEqual([
      [["ControlLeft"]],
      [["ControlLeft", "KeyA"]],
    ]);
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
    expect(getAppState().snackbarMessage).toContain("reload your compositor");
  });

  it("restores the prior value when bridge rejects a modifier-only shortcut", () => {
    focus();
    keys(["ControlLeft"]);
    keys([]);
    expect(onChange.mock.calls).toEqual([[["ControlLeft"]], [["KeyZ"]]]);
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
    expect(getAppState().snackbarMode).toBe("error");
    expect(getAppState().snackbarMessage).toContain("non-modifier");
  });

  it("accepts a modifier-only shortcut without bridge notifications for the listener strategy", () => {
    act(() => setAppState({ hotkeyStrategy: "listener" }));
    focus();
    keys(["ControlLeft"]);
    keys([]);
    expect(onChange.mock.calls).toEqual([[["ControlLeft"]]]);
    expect(getAppState().snackbarMessage).toBeUndefined();
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  });

  it("cancels a fresh recording on Escape without changing its value", () => {
    focus();
    keys(["Escape"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(isHotkeyCaptureActive(getAppState())).toBe(false);
  });
});
