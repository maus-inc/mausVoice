// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  document.body.innerHTML = "";
});

const nativeContextMenu = (target: Element, x = 120, y = 80): MouseEvent => {
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

    const input = container.querySelector("input")!;
    // Regression: the provider passes a NATIVE MouseEvent to handleContextMenu,
    // which previously dereferenced the React-only `nativeEvent` property and
    // threw a TypeError (suppressing the menu after preventDefault()).
    expect(() => nativeContextMenu(input)).not.toThrow();

    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Copy");
    expect(menu!.textContent).toContain("Paste");
    expect(menu!.textContent).toContain("Select All");
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
      const input = container.querySelector("input")!;
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

    const surface = container.querySelector("div")!;
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

describe("useContextMenu", () => {
  const Harness = () => {
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

  it("does not suppress the native menu when there are no items", () => {
    const EmptyHarness = () => {
      const menu = useContextMenu();
      return createElement(
        "div",
        null,
        createElement(
          "button",
          {
            "data-testid": "empty",
            onContextMenu: (e: React.MouseEvent) =>
              menu.handleContextMenu(e.nativeEvent, []),
          },
          "right-click me",
        ),
        menu.renderMenu(),
      );
    };
    act(() => {
      root.render(createElement(EmptyHarness));
    });
    const button = container.querySelector('[data-testid="empty"]')!;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });
    act(() => {
      button.dispatchEvent(event);
    });
    // An empty item list must NOT preventDefault (which would suppress the
    // platform menu) and must not render a menu.
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes on Escape", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = container.querySelector("button")!;
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("renders the menu into document.body, outside transformed ancestors", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = container.querySelector("button")!;
    nativeContextMenu(button, 200, 150);

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    // The portal must lift the menu out of the render container so no
    // ancestor's `filter`/`transform` can re-anchor or clip it.
    expect(container.contains(menu)).toBe(false);
    // Its positioned wrapper lives directly under <body>.
    const positioned = menu!.parentElement as HTMLElement;
    expect(positioned).not.toBeNull();
    expect(positioned.parentElement).toBe(document.body);
  });

  it("consumes Escape before host (e.g. dialog) keydown handlers see it", () => {
    const dialogKeydownSpy = vi.fn();
    document.addEventListener("keydown", dialogKeydownSpy);
    try {
      act(() => {
        root.render(createElement(Harness));
      });
      nativeContextMenu(container.querySelector("button")!);

      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.dispatchEvent(event);
      });

      // The menu closed and the event never continued to bubble-phase
      // listeners, so a wrapping MUI dialog survives the Escape.
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(dialogKeydownSpy).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", dialogKeydownSpy);
    }
  });

  it("moves keyboard focus into the menu so arrow navigation works", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    nativeContextMenu(container.querySelector("button")!);

    const menu = document.body.querySelector('[role="menu"]');
    expect(document.activeElement).toBe(menu);
  });

  it("runs the item action and closes on click", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = container.querySelector("button")!;
    nativeContextMenu(button);

    const item = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("Do thing")) as HTMLElement;
    expect(item).toBeTruthy();

    act(() => {
      item.click();
    });
    expect(container.querySelector('[data-testid="result"]')!.textContent).toBe(
      "thing",
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps the menu open when scrolling inside the menu itself", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = container.querySelector("button")!;
    nativeContextMenu(button);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();

    // The menu scrolls itself (overflowY: auto) when it has many items; that
    // must NOT dismiss the menu. The window scroll listener is registered in
    // the capture phase, so a scroll event dispatched on the menu element
    // reaches it with the menu as target.
    act(() => {
      menu.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("closes the menu when an external element scrolls", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = container.querySelector("button")!;
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
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

    const input = container.querySelector("input")!;
    nativeContextMenu(input);

    const menu = document.querySelector('[role="menu"]')!;
    expect(menu).not.toBeNull();
    // The provider's clipboard menu wins over the surface's Delete item.
    expect(menu.textContent).toContain("Copy");
    expect(menu.textContent).toContain("Paste");
    expect(menu.textContent).not.toContain("Delete");
  });
});
