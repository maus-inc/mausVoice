// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  useHotkeyFire,
  type UseHotkeyFireArgs,
} from "@maus-inc/desktop-utils/react";
import { ensureUiHarness } from "../../test/helpers/jsdom-ui-harness";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("useHotkeyFire", () => {
  it("fires on clean release, rejects extra keys and held keys across disable, then recovers", () => {
    const root = createRoot(document.createElement("div"));
    const onFire = vi.fn();
    const combos = [["Ctrl", "A"]];
    const Harness = (args: UseHotkeyFireArgs) => {
      useHotkeyFire(args);
      return null;
    };
    const render = (keysHeld: string[], isDisabled = false, triggerCount = 0) =>
      act(() =>
        root.render(
          createElement(Harness, {
            combos,
            keysHeld,
            isDisabled,
            triggerCount,
            onFire,
          }),
        ),
      );
    try {
      render([]);
      render(["ctrl", "A"]);
      render(["ctrl"]);
      expect(onFire).toHaveBeenCalledTimes(1);
      render([]);
      render(["CTRL", "a"]);
      render(["ctrl", "a", "extra"]);
      render(["ctrl", "a"]);
      render([]);
      expect(onFire).toHaveBeenCalledTimes(1);
      render(["ctrl", "a"], true);
      render(["ctrl", "a"]);
      render([]);
      expect(onFire).toHaveBeenCalledTimes(1);
      render(["ctrl", "a"]);
      render([]);
      expect(onFire).toHaveBeenCalledTimes(2);
      render([], false, 1);
      expect(onFire).toHaveBeenCalledTimes(3);
      render([], true, 2);
      render([], false, 2);
      expect(onFire).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
    }
  });
});
