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
