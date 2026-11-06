// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import { setTipAction } from "./tip-actions";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

const mocks = vi.hoisted(() => ({
  state: { local: { dismissedTipIds: [] as string[] } },
  dismissTip: vi.fn(),
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}));

vi.mock("../../actions/onboarding.actions", () => ({
  dismissTip: mocks.dismissTip,
}));

// jsdom cannot play the real exit animation, so the presence wrapper keeps the
// removed child mounted (as the real library does while it exits) and reports
// completion one tick later — the same contract `TipCard`'s deferred
// `dismissTip` relies on.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const AnimatePresence = ({
    children,
    onExitComplete,
  }: {
    children: ReactNode;
    onExitComplete?: () => void;
  }) => {
    const [exiting, setExiting] = React.useState<ReactNode | null>(null);
    const previous = React.useRef<ReactNode | null>(null);
    const timerId = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const live = children ?? null;
    React.useEffect(() => {
      if (live) {
        previous.current = live;
        setExiting((current) => (current === null ? current : null));
        return;
      }
      if (previous.current === null || timerId.current !== null) return;
      setExiting(previous.current);
      previous.current = null;
      // No per-render cleanup: the re-render caused by `setExiting` would
      // cancel the very completion it is waiting for.
      timerId.current = globalThis.setTimeout(() => {
        timerId.current = null;
        onExitComplete?.();
      }, 0);
    });
    React.useEffect(
      () => () => {
        if (timerId.current !== null) {
          globalThis.clearTimeout(timerId.current);
          timerId.current = null;
        }
      },
      [],
    );
    return live ?? exiting ?? null;
  };
  return {
    useReducedMotion: () => true,
    AnimatePresence,
    motion: {
      div: ({ children }: { children: ReactNode }) =>
        React.createElement("div", null, children),
    },
  };
});

import { TipCard, TipCardFrame } from "./TipCard";

ensureUiHarness();
setMatchMedia(false);

let container: HTMLDivElement;
let root: Root;

const dismissButton = (): HTMLButtonElement => {
  const button = container.querySelector('button[aria-label="Dismiss tip"]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Dismiss control not found");
  }
  return button;
};

const buttonWithText = (text: string): HTMLButtonElement => {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent === text);
  if (!button) {
    throw new Error(`Button "${text}" not found`);
  }
  return button;
};

const renderCard = (
  props: Parameters<typeof TipCard>[0] = { id: "review-before-insert" },
) =>
  act(() => {
    root.render(
      createElement(
        ThemeProvider,
        { theme, ...THEME_PROVIDER_CONFIG },
        createElement(MemoryRouter, null, createElement(TipCard, props)),
      ),
    );
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.local.dismissedTipIds = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TipCard", () => {
  const cardChrome = (): HTMLElement => {
    const card = container.querySelector('[data-tip-card="true"]');
    if (!(card instanceof HTMLElement)) {
      throw new Error("Card chrome not found");
    }
    return card;
  };

  it("renders the icon, copy, pattern image, and dismiss control for a live tip", async () => {
    await renderCard();

    expect(container.textContent).toContain("Review before it inserts");
    expect(container.textContent).toContain(
      "Review mode holds each transcript on the pill first",
    );
    // The lucide glyph carries the icon family class the theme styles.
    expect(container.querySelector(".lucide")).toBeTruthy();
    // The header art sits above the icon, copy, and dismiss control.
    expect(container.querySelector('img[alt=""]')).toBeTruthy();
    expect(dismissButton()).toBeTruthy();
  });

  it("carries the floating-layer face: paper, hairline, premium lift", async () => {
    await renderCard();

    const style = getComputedStyle(cardChrome());
    // Live tips float over the page, so they take the floating-layer
    // material the toasts use: a 1px hairline and the `premiumSurface` lift
    // (its inset emboss is the marker — no other app shadow carries one).
    // The paper face resolves through a theme CSS variable, which jsdom
    // reports unresolved, so it is asserted by its variable reference.
    expect(style.borderTopWidth).toBe("1px");
    expect(style.backgroundColor).toBe("var(--app-palette-background-paper)");
    expect(style.boxShadow).toContain("inset");
  });

  it("holds the toast column width so the two corner stacks align", async () => {
    await renderCard();

    // Sonner's default toast width; the tip stack must share the column.
    expect(getComputedStyle(cardChrome()).width).toBe("356px");
  });

  it("moves the dismiss control onto the pattern image, out of the row below", async () => {
    await renderCard();

    const image = container.querySelector('img[alt=""]');
    if (!(image instanceof HTMLElement)) {
      throw new Error("Pattern image not found");
    }
    // The dismiss control sits in the image's own header section, not in
    // the row `TipCardFrame` renders below it for the icon, title, and body.
    const header = image.parentElement;
    expect(header?.contains(dismissButton())).toBe(true);
    const row = container.querySelector('[data-tip-frame="true"]');
    expect(row?.contains(dismissButton())).toBe(false);
  });

  it("makes the row itself the activation target for a tip with no live action", async () => {
    await renderCard();

    // `review-before-insert` has no `TIP_LIVE_ACTIONS` entry, so its whole
    // title-and-body row becomes the one-click way to mark it read.
    const row = container.querySelector('[data-tip-frame="true"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error("Row not found");
    }
    expect(row.getAttribute("role")).toBe("button");

    act(() => {
      row.click();
    });
    expect(mocks.dismissTip).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mocks.dismissTip).toHaveBeenCalledWith("review-before-insert");
    });
  });

  it("marks an actionless tip read from the keyboard as well as a click", async () => {
    await renderCard();

    const row = container.querySelector('[data-tip-frame="true"]');
    if (!(row instanceof HTMLElement)) {
      throw new Error("Row not found");
    }

    act(() => {
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await vi.waitFor(() => {
      expect(mocks.dismissTip).toHaveBeenCalledWith("review-before-insert");
    });
  });

  it("leaves the row inert for a tip with a live action, so the action stays the one effect", async () => {
    const onAction = vi.fn();
    const unregister = setTipAction("generative-provider", onAction);
    try {
      await renderCard({ id: "generative-provider" });

      const row = container.querySelector('[data-tip-frame="true"]');
      if (!(row instanceof HTMLElement)) {
        throw new Error("Row not found");
      }
      // A live action keeps its own button as the row's only effect, so the
      // row never becomes a second, competing way to trigger it.
      expect(row.getAttribute("role")).toBe("note");

      act(() => {
        row.click();
      });
      expect(onAction).not.toHaveBeenCalled();
      expect(mocks.dismissTip).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("renders no action for a tip anchored on its own feature page", async () => {
    await renderCard();

    // `review-before-insert` has no entry in `TIP_LIVE_ACTIONS`, so only
    // the dismiss control is present — the page the tip floats over is the
    // feature itself.
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(dismissButton()).toBeTruthy();
  });

  it("renders nothing for a dismissed tip", async () => {
    mocks.state.local.dismissedTipIds = ["review-before-insert"];
    await renderCard();

    expect(container.querySelector(".lucide")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("persists the dismissal once the exit animation finishes", async () => {
    await renderCard();

    expect(mocks.dismissTip).not.toHaveBeenCalled();
    act(() => {
      dismissButton().click();
    });

    // The click only starts the exit; the store update waits for it.
    expect(mocks.dismissTip).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mocks.dismissTip).toHaveBeenCalledWith("review-before-insert");
    });
  });

  it("persists the dismissal if the tip unmounts mid-exit", async () => {
    // Navigating away during the exit animation interrupts it, so the
    // exit-completion path never runs. The dismissal is a deliberate choice
    // and must still persist, or the tip reappears on the next visit.
    await renderCard();

    act(() => {
      dismissButton().click();
    });
    expect(mocks.dismissTip).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    expect(mocks.dismissTip).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTip).toHaveBeenCalledWith("review-before-insert");
  });

  it("does not persist the dismissal twice on repeated clicks", async () => {
    await renderCard();

    act(() => {
      dismissButton().click();
      dismissButton().click();
    });

    await vi.waitFor(() => {
      expect(mocks.dismissTip).toHaveBeenCalledTimes(1);
    });
  });

  it("runs the in-page action through the route page's handler", async () => {
    // The handler lives on the tip's route page (see `tip-actions`); the
    // card looks it up at click time.
    const onAction = vi.fn();
    const unregister = setTipAction("generative-provider", onAction);
    try {
      await renderCard({ id: "generative-provider" });

      expect(container.textContent).toContain(
        "Add an AI provider for polishing",
      );
      act(() => {
        buttonWithText("Add API key").click();
      });

      expect(onAction).toHaveBeenCalledTimes(1);
      // The action performs an in-page jump; it must not consume the tip.
      expect(mocks.dismissTip).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});

describe("TipCardFrame", () => {
  const frameCard = (): HTMLElement => {
    const target = container.querySelector('[data-tip-frame="true"]');
    if (!(target instanceof HTMLElement)) {
      throw new Error("Card not found in frame");
    }
    return target;
  };

  const renderFrame = (
    props: Parameters<typeof TipCardFrame>[0] &
      Partial<Parameters<typeof TipCardFrame>[0]>,
  ) =>
    act(() => {
      root.render(
        createElement(
          ThemeProvider,
          { theme, ...THEME_PROVIDER_CONFIG },
          createElement(MemoryRouter, null, createElement(TipCardFrame, props)),
        ),
      );
    });

  it("applies plain-object sx overrides on top of the base card", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: { opacity: 0.42 },
    });

    expect(getComputedStyle(frameCard()).opacity).toBe("0.42");
  });

  it("applies array-form sx (HelpPage passes [dismissed && {...}])", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: [{ opacity: 0.5 }],
    });

    expect(getComputedStyle(frameCard()).opacity).toBe("0.5");
  });

  it("applies function-form sx resolved against the theme", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: (t) => ({ opacity: 0.42, color: (t as typeof theme).palette.level1 }),
    });

    const card = frameCard();
    expect(getComputedStyle(card).opacity).toBe("0.42");
    // Resolve the expected color from the theme itself so the assertion
    // tracks the token instead of a copy of it.
    const hex = (theme.palette.level1 as string).slice(1);
    const [r, g, b] = [0, 2, 4].map((i) =>
      Number.parseInt(hex.slice(i, i + 2), 16),
    );
    expect(getComputedStyle(card).color).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  it("lets sx overrides beat the base card styles", async () => {
    await renderFrame({
      title: "Title",
      body: "Body",
      sx: { borderTopWidth: 3 },
    });

    expect(getComputedStyle(frameCard()).borderTopWidth).toBe("3px");
  });

  it("stays a plain note with no role=button when onActivate is not passed", async () => {
    await renderFrame({ title: "Title", body: "Body" });

    expect(frameCard().getAttribute("role")).toBe("note");
    expect(frameCard().getAttribute("tabindex")).toBeNull();
  });

  it("becomes a keyboard- and click-reachable button when onActivate is passed", async () => {
    const onActivate = vi.fn();
    await renderFrame({ title: "Title", body: "Body", onActivate });

    const card = frameCard();
    expect(card.getAttribute("role")).toBe("button");
    expect(card.getAttribute("tabindex")).toBe("0");

    act(() => {
      card.click();
    });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("ignores a space key bubbling up from a nested action button", async () => {
    // `actions` can render its own focusable button (the live-action case).
    // A key event targeting that child and bubbling up must not also fire
    // the row's own `onActivate`, or one press would trigger two effects.
    const onActivate = vi.fn();
    await renderFrame({
      title: "Title",
      body: "Body",
      onActivate,
      actions: createElement("button", { type: "button" }, "Do the thing"),
    });

    const button = container.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Nested action button not found");
    }
    act(() => {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("stops a click on the actions stack from also activating the row", async () => {
    const onActivate = vi.fn();
    const onActionClick = vi.fn();
    await renderFrame({
      title: "Title",
      body: "Body",
      onActivate,
      actions: createElement(
        "button",
        { type: "button", onClick: onActionClick },
        "Do the thing",
      ),
    });

    const button = container.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Nested action button not found");
    }
    act(() => {
      button.click();
    });
    expect(onActionClick).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
