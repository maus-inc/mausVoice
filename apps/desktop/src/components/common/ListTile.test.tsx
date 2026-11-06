// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ListTile } from "./ListTile";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ListTile actions", () => {
  it("calls the row action but keeps leading and trailing actions isolated", async () => {
    const row = vi.fn();
    const leading = vi.fn();
    const trailing = vi.fn();
    await act(async () =>
      root.render(
        createElement(ListTile, {
          title: "Item",
          leading: "L",
          leadingHover: "Leading action",
          leadingOnClick: leading,
          trailing: "T",
          trailingHover: "Trailing action",
          trailingOnClick: trailing,
          onClick: row,
        }),
      ),
    );
    const rowElement = container.querySelector(".MuiListItemButton-root");
    const actionButtons = container.querySelectorAll(".MuiIconButton-root");
    expect(rowElement).not.toBeNull();
    expect(actionButtons).toHaveLength(2);
    act(() =>
      actionButtons[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    act(() =>
      actionButtons[1].dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      ),
    );
    expect(leading).toHaveBeenCalledOnce();
    expect(trailing).toHaveBeenCalledOnce();
    expect(row).not.toHaveBeenCalled();
    act(() =>
      rowElement!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(row).toHaveBeenCalledOnce();
  });
  it("forwards the real list-item ref and exposes the selected current state", async () => {
    const ref = createRef<HTMLLIElement>();
    await act(async () =>
      root.render(
        <ListTile
          component="li"
          ref={ref}
          title="History"
          selected
          ariaCurrent="page"
        />,
      ),
    );
    expect(ref.current?.tagName).toBe("LI");
    expect(
      ref.current
        ?.querySelector('[aria-current="page"]')
        ?.classList.contains("Mui-selected"),
    ).toBe(true);
  });

  it("shows hover actions for keyboard focus and hides them when focus leaves the tile", async () => {
    await act(async () =>
      root.render(
        <ListTile title="Item" trailing="idle" trailingHover="Action" />,
      ),
    );
    const row = container.querySelector<HTMLElement>(
      ".MuiListItemButton-root",
    )!;
    const action = container.querySelector<HTMLElement>(".MuiIconButton-root")!;
    expect(getComputedStyle(action).display).toBe("none");
    act(() => row.focus());
    expect(getComputedStyle(action).display).toBe("inline-flex");
    act(() => row.blur());
    expect(getComputedStyle(action).display).toBe("none");
  });

  it("does not invoke the row action while disabled", async () => {
    const rowAction = vi.fn();
    await act(async () =>
      root.render(<ListTile title="Item" disabled onClick={rowAction} />),
    );
    const row = container.querySelector<HTMLElement>(
      ".MuiListItemButton-root",
    )!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    act(() => row.click());
    expect(rowAction).not.toHaveBeenCalled();
  });
  it("composes caller sx arrays after the shell styles", async () => {
    await act(async () =>
      root.render(
        <ListTile
          title="Item"
          sx={[{ color: "rgb(1, 2, 3)" }, { color: "rgb(4, 5, 6)" }]}
        />,
      ),
    );
    const shell = container.querySelector<HTMLElement>(".MuiListItem-root")!;
    expect(getComputedStyle(shell).position).toBe("relative");
    expect(getComputedStyle(shell).color).toBe("rgb(4, 5, 6)");
  });
});
