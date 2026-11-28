// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { ContextMenu } from "./ContextMenuSurface";

ensureUiHarness();

it("starts ArrowUp at the last enabled action", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <ContextMenu
          items={[
            { label: "First", onClick: vi.fn() },
            { kind: "divider" },
            { label: "Last", onClick: vi.fn() },
            { label: "Disabled", onClick: vi.fn(), disabled: true },
          ]}
        />,
      ),
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    act(() =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );
    expect(menu.getAttribute("aria-activedescendant")).toBe(
      "context-menu-item-2",
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
