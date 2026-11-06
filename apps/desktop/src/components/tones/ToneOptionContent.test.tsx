// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vitest";
import { ToneOptionContent } from "./ToneOptionContent";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToneOptionContent", () => {
  it.each([
    { global: true, system: false, icon: "PublicIcon", editable: false },
    { global: true, system: true, icon: "PublicIcon", editable: false },
    { global: false, system: true, icon: null, editable: false },
    { global: false, system: false, icon: "EditIcon", editable: true },
  ])(
    "renders the appropriate option affordance ($global, $system)",
    async ({ global, system, icon, editable }) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const edit = vi.fn();
      const parentClick = vi.fn();
      await act(async () =>
        root.render(
          createElement(
            IntlProvider,
            { locale: "en", messages: {} },
            createElement(
              "div",
              { onClick: parentClick },
              createElement(ToneOptionContent, {
                name: "Style",
                isGlobal: global,
                isSystem: system,
                onEdit: edit,
              }),
            ),
          ),
        ),
      );
      expect(container.textContent).toContain("Style");
      expect(
        container.querySelector("svg")?.getAttribute("data-testid") ?? null,
      ).toBe(icon);
      const button = container.querySelector("button");
      expect(Boolean(button)).toBe(editable);
      if (button) {
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        });
        await act(async () => button.dispatchEvent(event));
        expect(edit).toHaveBeenCalledOnce();
        expect(parentClick).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
      }
      act(() => root.unmount());
      container.remove();
    },
  );
});
