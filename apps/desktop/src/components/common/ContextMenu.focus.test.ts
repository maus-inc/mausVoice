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
import { useContextMenu } from "./ContextMenu";
import {
  container,
  root,
  nativeContextMenu,
  queryRequired,
  Harness,
} from "./context-menu-test-utils";

describe("useContextMenu", () => {
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
    const button = queryRequired(container, '[data-testid="empty"]');
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
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("closes on Tab without swallowing the key, so focus is not trapped", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // A vertical menu must not cycle focus with Tab: the menu has to dismiss
    // AND leave the event alone, otherwise keyboard focus cannot leave the
    // open menu and Escape becomes the only undiscoverable way out.
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("returns focus to the surface on Tab instead of dropping it on the body", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    expect(document.activeElement).toBe(
      document.body.querySelector('[role="menu"]'),
    );

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // The menu held the focused node, so dismissing it without a restore
    // target unmounts whatever was focused and leaves the document on the
    // body. The browser's next Tab then restarts from the top of the page
    // rather than continuing where the user was.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("returns focus to the nearest focusable ancestor of a non-focusable surface host", () => {
    // Every wired surface renders its host as a plain `Box component="div"`
    // with no tabIndex, so the element the user right-clicked can never take
    // focus and `focus()` on it is a no-op. Restoring to it dropped the user
    // on the body, from where the next Tab restarts at the top of the
    // document. The row's own focusable child is the real return target.
    const RowHarness = () => {
      const menu = useContextMenu();
      return createElement(
        "div",
        {
          "data-testid": "row",
          onContextMenu: (e: React.MouseEvent) =>
            menu.handleContextMenu(e.nativeEvent, [
              { label: "Do thing", onClick: () => undefined },
            ]),
        },
        createElement(
          "div",
          { "data-testid": "row-button", role: "button", tabIndex: 0 },
          createElement(
            "span",
            { "data-testid": "row-text" },
            "right-click me",
          ),
        ),
        menu.renderMenu(),
      );
    };
    act(() => {
      root.render(createElement(RowHarness));
    });

    const text = queryRequired(container, '[data-testid="row-text"]');
    const rowButton = queryRequired(container, '[data-testid="row-button"]');
    nativeContextMenu(text);
    expect(document.activeElement).toBe(
      document.body.querySelector('[role="menu"]'),
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    // The host div is not focusable, so the restore has to land on the
    // focusable row inside it rather than nowhere.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(rowButton);
  });
});
