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
  container,
  root,
  nativeContextMenu,
  browserRightClick,
  queryRequired,
  Harness,
  BareHarness,
} from "./context-menu-test-utils";

describe("useContextMenu", () => {
  it("restores the focused element when the surface host cannot take focus", () => {
    // Same non-focusable host, but nothing inside it can take focus either, so
    // there is no target on the surface at all. The element that holds focus is
    // then the only place the user can be put back. Opening the menu from the
    // keyboard sends no mousedown, so nothing unfocused it.
    act(() => {
      root.render(createElement(BareHarness));
    });

    const input = container.querySelector(
      '[data-testid="search"]',
    ) as HTMLInputElement;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    nativeContextMenu(queryRequired(container, '[data-testid="bare-text"]'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(document.activeElement).toBe(input);
  });

  it("restores the element a right-click unfocused on a surface with nothing focusable", () => {
    // This is the shape of `TranscriptRow` and `ChatMessageBubble`: a plain
    // `div`/`Stack` host, no focusable ancestor anywhere above it, and a menu
    // opened by right-clicking its text. The mousedown the browser sends first
    // runs its focusing steps, which unfocus the element the user was on, so by
    // the time the menu opens `document.activeElement` is the body. Only an
    // element captured before that mousedown can name where to go back to, and
    // reading the live one lands the user on the body, from where the next Tab
    // restarts at the top of the document.
    act(() => {
      root.render(createElement(BareHarness));
    });

    const input = container.querySelector(
      '[data-testid="search"]',
    ) as HTMLInputElement;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    browserRightClick(queryRequired(container, '[data-testid="bare-text"]'));
    expect(document.activeElement).toBe(
      document.body.querySelector('[role="menu"]'),
    );

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(input);
  });

  it("closes on Shift+Tab without swallowing the key either", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders the menu into document.body, outside transformed ancestors", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button, 200, 150);

    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    // The portal must lift the menu out of the render container so no
    // ancestor's `filter`/`transform` can re-anchor or clip it.
    expect(container.contains(menu)).toBe(false);
    // Its positioned wrapper lives directly under <body>.
    const positioned = menu?.parentElement;
    expect(positioned).not.toBeNull();
    expect(positioned?.parentElement).toBe(document.body);
  });

  it("consumes Escape before host (e.g. dialog) keydown handlers see it", () => {
    const dialogKeydownSpy = vi.fn();
    document.addEventListener("keydown", dialogKeydownSpy);
    try {
      act(() => {
        root.render(createElement(Harness));
      });
      nativeContextMenu(queryRequired(container, "button"));

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
    nativeContextMenu(queryRequired(container, "button"));

    const menu = document.body.querySelector('[role="menu"]');
    expect(document.activeElement).toBe(menu);
  });

  it("runs the item action and closes on click", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);

    const item = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("Do thing")) as HTMLElement;
    expect(item).toBeTruthy();

    act(() => {
      item.click();
    });
    expect(queryRequired(container, '[data-testid="result"]').textContent).toBe(
      "thing",
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("ignores a scroll already queued when the menu opened, but dismisses on a later scroll", async () => {
    act(() => root.render(createElement(Harness)));
    nativeContextMenu(queryRequired(container, "button"));
    act(() =>
      document.body.dispatchEvent(new Event("scroll", { bubbles: true })),
    );
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() =>
      document.body.dispatchEvent(new Event("scroll", { bubbles: true })),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("keeps the menu open when scrolling inside the menu itself", () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    const menu = queryRequired(document, '[role="menu"]');
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

  it("closes the menu when an external element scrolls", async () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() => {
      document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  // The scroll listener is on `window` with capture, so `e.target` is whatever
  // scrolled. A page-level scroll targets `document`, not an Element -- and
  // `Document` has no `closest`, so the handler used to throw a TypeError on
  // exactly this event and the `closeMenu` below it never ran. The test above
  // dispatches on `document.body`, which is an Element, so it passed regardless.
  it("closes the menu when the document itself scrolls, without throwing", async () => {
    act(() => {
      root.render(createElement(Harness));
    });
    const button = queryRequired(container, "button");
    nativeContextMenu(button);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    act(() => {
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
