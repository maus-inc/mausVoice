import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect } from "vitest";
import { useContextMenu } from "./useContextMenu";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export let container: HTMLDivElement;
export let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

export const nativeContextMenu = (
  target: Element,
  x = 120,
  y = 80,
): MouseEvent => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

/**
 * A right-click the way the browser sends one: the `mousedown` first, then the
 * focusing steps it runs as its default action, then the `contextmenu`.
 *
 * jsdom does not run the focusing steps, so a test that dispatches only
 * `contextmenu` leaves the old focus sitting in `document.activeElement` and
 * cannot tell a working restore from a broken one. The steps unfocus the
 * current element when the target is not focusable, which is exactly the case
 * for the surfaces with no focusable ancestor, so that is what this does and
 * it asserts the resulting focus really is on the body.
 */
export const browserRightClick = (
  target: Element,
  x = 120,
  y = 80,
): MouseEvent => {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: x,
        clientY: y,
      }),
    );
  });
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  expect(document.activeElement).toBe(document.body);
  return nativeContextMenu(target, x, y);
};

/**
 * `querySelector` that throws when nothing matches, the same shape as the
 * `openContextMenu` guard in `test/helpers/context-menu.ts`. A non-null
 * assertion would hand the next line a `null` that surfaces as a TypeError
 * naming neither the selector nor the surface, whereas this fails with the
 * selector that came up empty.
 */
export const queryRequired = <T extends Element = HTMLElement>(
  scope: ParentNode,
  selector: string,
): T => {
  const found = scope.querySelector<T>(selector);
  if (!found) {
    throw new Error(
      `Expected an element matching "${selector}" to be rendered`,
    );
  }
  return found;
};

export const Harness = () => {
  const menu = useContextMenu();
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        "data-testid": "target",
        onContextMenu: (e: React.MouseEvent) =>
          menu.handleContextMenu(e.nativeEvent, [
            {
              label: "Do thing",
              onClick: () => setLastLabel("thing"),
            },
          ]),
      },
      "right-click me",
    ),
    createElement("span", { "data-testid": "result" }, lastLabel ?? "none"),
    menu.renderMenu(),
  );
};

/**
 * A surface with nothing focusable in it or above it, matching the wired
 * hosts that render a plain `div`/`Stack`, plus a focusable control
 * elsewhere in the app for the user to have come from.
 */
export const BareHarness = () => {
  const menu = useContextMenu();
  return createElement(
    "div",
    null,
    createElement("input", { "data-testid": "search" }),
    createElement(
      "div",
      {
        "data-testid": "bare",
        onContextMenu: (e: React.MouseEvent) =>
          menu.handleContextMenu(e.nativeEvent, [
            { label: "Do thing", onClick: () => undefined },
          ]),
      },
      createElement("span", { "data-testid": "bare-text" }, "right-click me"),
    ),
    menu.renderMenu(),
  );
};
