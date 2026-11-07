// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ContextMenu } from "./ContextMenuSurface";

ensureUiHarness();

it("focuses the context menu without scrolling its page", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  try {
    act(() =>
      root.render(
        <ContextMenu items={[{ label: "Delete", onClick: vi.fn() }]} />,
      ),
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  } finally {
    act(() => root.unmount());
    focus.mockRestore();
    host.remove();
  }
});

it("keeps keyboard selection distinct from a stationary pointer and restores pointer selection on movement", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ContextMenu
          items={[
            { label: "Edit", onClick: vi.fn() },
            { label: "Delete", onClick: vi.fn() },
          ]}
        />,
      ),
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    act(() => {
      rows[1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(menu.dataset.keyboardNavigation).toBe("true");
    expect(menu.getAttribute("aria-activedescendant")).toBe(
      "context-menu-item-0",
    );
    act(() =>
      rows[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true })),
    );
    expect(menu.dataset.keyboardNavigation).toBe("true");
    act(() => {
      const move = new MouseEvent("mousemove", { bubbles: true });
      Object.defineProperty(move, "movementX", { value: 1 });
      rows[1].dispatchEvent(move);
    });
    expect(menu.dataset.keyboardNavigation).toBe("false");
    expect(menu.getAttribute("aria-activedescendant")).toBe(
      "context-menu-item-1",
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
