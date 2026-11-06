// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ActivationController } from "@maus-inc/desktop-utils";
import {
  useHotkeyHoldMany,
  type UseHotkeyHoldManyArgs,
} from "@maus-inc/desktop-utils/react";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const fakeController = () => ({
  isActive: false,
  hasHadRelease: false,
  shouldIgnoreActivation: false,
  reset: vi.fn(),
  forceReset: vi.fn(),
  handlePress: vi.fn(),
  handleRelease: vi.fn(),
  clearIgnore: vi.fn(),
  toggle: vi.fn(),
});
const Harness = (args: UseHotkeyHoldManyArgs) => {
  useHotkeyHoldMany(args);
  return null;
};

describe("useHotkeyHoldMany", () => {
  it("tracks case-insensitive presses and tolerated keys, resets while disabled and handles triggers", () => {
    const root = createRoot(document.createElement("div"));
    const controller = fakeController();
    const action = {
      controller: controller as unknown as ActivationController,
      combos: [["CTRL", "a"]],
      allowedAdditionalKeys: ["ArrowUp"],
      triggerCount: 0,
    };
    const render = (keysHeld: string[], isDisabled = false) =>
      act(() =>
        root.render(
          createElement(Harness, { actions: [action], keysHeld, isDisabled }),
        ),
      );
    try {
      render([]);
      render(["ctrl", "A", "ARROWUP", "ctrl"]);
      render(["Ctrl", "a"]);
      expect(controller.handlePress).toHaveBeenCalledTimes(1);
      render(["ctrl", "a", "other"]);
      expect(controller.clearIgnore).toHaveBeenCalledTimes(1);
      expect(controller.handleRelease).toHaveBeenCalledTimes(1);
      render(["ctrl", "a"], true);
      expect(controller.reset).toHaveBeenCalledTimes(1);
      render(["ctrl", "a"]);
      expect(controller.handlePress).toHaveBeenCalledTimes(1);
      render([]);
      render(["ctrl", "a"]);
      expect(controller.handlePress).toHaveBeenCalledTimes(2);
      action.triggerCount = 1;
      render(["ctrl", "a"]);
      expect(controller.toggle).toHaveBeenCalledTimes(1);
      action.triggerCount = 2;
      render([], true);
      render([]);
      expect(controller.toggle).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears stale active state and honors ignore-activation and missing combos", () => {
    const root = createRoot(document.createElement("div"));
    const controller = fakeController();
    controller.isActive = true;
    controller.shouldIgnoreActivation = true;
    const action = {
      controller: controller as unknown as ActivationController,
      combos: [["a"]],
      triggerCount: 0,
    };
    const render = (keysHeld: string[]) =>
      act(() =>
        root.render(createElement(Harness, { actions: [action], keysHeld })),
      );
    try {
      render([]);
      expect(controller.reset).toHaveBeenCalledTimes(1);
      controller.isActive = false;
      render(["a"]);
      expect(controller.handlePress).not.toHaveBeenCalled();
      render([]);
      expect(controller.clearIgnore).toHaveBeenCalledTimes(1);
      expect(controller.handleRelease).toHaveBeenCalledTimes(1);
      action.combos = [];
      render([]);
      expect(controller.reset).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});

it("resets a removed hold controller without resetting controllers that remain", () => {
  const root = createRoot(document.createElement("div"));
  const removed = fakeController();
  const retained = fakeController();
  const first = {
    controller: removed as unknown as ActivationController,
    combos: [["a"]],
    triggerCount: 0,
  };
  const second = {
    controller: retained as unknown as ActivationController,
    combos: [["b"]],
    triggerCount: 0,
  };
  try {
    act(() =>
      root.render(
        createElement(Harness, { actions: [first, second], keysHeld: ["a"] }),
      ),
    );
    act(() =>
      root.render(createElement(Harness, { actions: [second], keysHeld: [] })),
    );
    expect(removed.reset).toHaveBeenCalledOnce();
    expect(retained.reset).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

it("deactivates an active capture when its hotkey binding disappears", async () => {
  const { ActivationController } = await import("@maus-inc/desktop-utils");
  const root = createRoot(document.createElement("div"));
  const start = vi.fn();
  const stop = vi.fn();
  const controller = new ActivationController(start, stop, true);
  const action = { controller, combos: [["a"]], triggerCount: 0 };
  try {
    await act(async () =>
      root.render(createElement(Harness, { actions: [action], keysHeld: [] })),
    );
    await act(async () =>
      root.render(
        createElement(Harness, { actions: [action], keysHeld: ["a"] }),
      ),
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    await act(async () =>
      root.render(createElement(Harness, { actions: [], keysHeld: ["a"] })),
    );
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  } finally {
    act(() => root.unmount());
  }
});
