// @vitest-environment jsdom
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});
import {
  ContextMenuProvider,
  isEditableTarget,
  useContextMenu,
} from "./ContextMenu";
import {
  container,
  root,
  nativeContextMenu,
  queryRequired,
} from "./context-menu-test-utils";

describe("ContextMenuProvider", () => {
  it("shows the clipboard menu on input right-click without throwing", () => {
    act(() => {
      root.render(
        createElement(
          ContextMenuProvider,
          null,
          createElement("input", { defaultValue: "hello" }),
        ),
      );
    });

    const input = queryRequired(container, "input");
    // Regression: the provider passes a NATIVE MouseEvent to handleContextMenu,
    // which previously dereferenced the React-only `nativeEvent` property and
    // threw a TypeError (suppressing the menu after preventDefault()).
    expect(() => nativeContextMenu(input)).not.toThrow();

    const menu = queryRequired(document, '[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Copy");
    expect(menu.textContent).toContain("Paste");
    expect(menu.textContent).toContain("Select All");
  });

  const copyItem = (): HTMLElement | undefined =>
    Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
      el.textContent?.includes("Copy"),
    ) as HTMLElement | undefined;

  it("enables Copy only when the input actually has a selection", () => {
    const render = (select: boolean) => {
      act(() => {
        root.render(
          createElement(
            ContextMenuProvider,
            null,
            createElement("input", { defaultValue: "hello world" }),
          ),
        );
      });
      const input = queryRequired<HTMLInputElement>(container, "input");
      if (select) {
        // window.getSelection() does NOT reflect <input> selection — the menu
        // must read selectionStart/selectionEnd instead (regression: Copy was
        // previously always disabled for inputs).
        input.setSelectionRange(0, 5);
      }
      nativeContextMenu(input);
    };

    render(false);
    expect(copyItem()?.getAttribute("aria-disabled")).toBe("true");

    render(true);
    expect(copyItem()?.getAttribute("aria-disabled")).toBeNull();
  });

  it("leaves non-input surfaces to the default webview menu", () => {
    act(() => {
      root.render(
        createElement(
          ContextMenuProvider,
          null,
          createElement("div", null, "plain surface"),
        ),
      );
    });

    const surface = queryRequired(container, "div");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    act(() => {
      surface.dispatchEvent(event);
    });

    // preventDefault() must NOT fire for non-inputs, so the webview's native
    // menu is preserved (no custom menu is rendered either).
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("returns true for inputs/textareas and false for plain elements", () => {
    const input = document.createElement("input");
    expect(isEditableTarget(input)).toBe(true);
    const textarea = document.createElement("textarea");
    expect(isEditableTarget(textarea)).toBe(true);
    const div = document.createElement("div");
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("returns true for contenteditable hosts and their descendants", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    expect(isEditableTarget(host)).toBe(true);
    const child = document.createElement("span");
    child.textContent = "x";
    host.appendChild(child);
    expect(isEditableTarget(child)).toBe(true);
  });
});

describe("surface yields editable right-clicks to the provider", () => {
  it("shows the clipboard menu (not the surface menu) on an input", () => {
    const SurfaceHarness = () => {
      const menu = useContextMenu();
      return createElement(
        "div",
        {
          // A surface that yields editable targets to the provider, matching
          // the wired surfaces (TranscriptRow/DictionaryRow/…).
          onContextMenu: (e: React.MouseEvent) => {
            if (isEditableTarget(e.target)) return;
            menu.handleContextMenu(e.nativeEvent, [
              {
                label: "Delete",
                danger: true,
                onClick: () => undefined,
              },
            ]);
          },
        },
        createElement("input", { defaultValue: "hello" }),
        menu.renderMenu(),
      );
    };

    act(() => {
      root.render(
        createElement(ContextMenuProvider, null, createElement(SurfaceHarness)),
      );
    });

    const input = queryRequired(container, "input");
    nativeContextMenu(input);

    const menu = queryRequired(document, '[role="menu"]');
    expect(menu).not.toBeNull();
    // The provider's clipboard menu wins over the surface's Delete item.
    expect(menu.textContent).toContain("Copy");
    expect(menu.textContent).toContain("Paste");
    expect(menu.textContent).not.toContain("Delete");
  });
});
