// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ContextMenu } from "./ContextMenuSurface";
import { useContextMenu } from "./useContextMenu";

ensureUiHarness();
const rect = (top: number, bottom: number, width = 180) =>
  ({
    x: 0,
    y: top,
    left: 0,
    right: width,
    top,
    bottom,
    width,
    height: bottom - top,
    toJSON: () => ({}),
  }) as DOMRect;

it("clamps using the rendered menu size rather than the row-height estimate", () => {
  vi.stubGlobal("innerWidth", 400);
  vi.stubGlobal("innerHeight", 300);
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "menu"
        ? rect(0, 220)
        : rect(0, 0, 0);
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Harness = () => {
    const menu = useContextMenu();
    return (
      <>
        <button
          onContextMenu={(e) =>
            menu.handleContextMenu(e.nativeEvent, [
              { label: "A", onClick: () => {} },
            ])
          }
        >
          Open
        </button>
        {menu.renderMenu()}
      </>
    );
  };
  try {
    act(() => root.render(<Harness />));
    act(() =>
      host.querySelector("button")!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 390,
          clientY: 290,
        }),
      ),
    );
    const wrapper = document.querySelector('[role="menu"]')!.parentElement!;
    expect(wrapper.style.left).toBe("206px");
    expect(wrapper.style.top).toBe("68px");
  } finally {
    act(() => root.unmount());
    host.remove();
    measure.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("reveals the keyboard-active item by scrolling only the menu", () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "menu") return rect(50, 150);
      if (this.id === "context-menu-item-2") return rect(160, 200);
      return rect(0, 0, 0);
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ContextMenu
          items={["One", "Two", "Three"].map((label) => ({
            label,
            onClick: () => {},
          }))}
        />,
      ),
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    act(() =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(menu.getAttribute("aria-activedescendant")).toBe(
      "context-menu-item-2",
    );
    expect(menu.scrollTop).toBe(50);
  } finally {
    act(() => root.unmount());
    host.remove();
    measure.mockRestore();
  }
});
