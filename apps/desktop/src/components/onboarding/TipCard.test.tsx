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
  act(async () => {
    root.render(
      createElement(MemoryRouter, null, createElement(TipCard, props)),
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
  it("renders the icon, copy, and dismiss control for a live tip", async () => {
    await renderCard();

    expect(container.textContent).toContain("Review before it inserts");
    expect(container.textContent).toContain(
      "Review mode holds each transcript on the pill first",
    );
    // The lucide glyph carries the icon family class the theme styles.
    expect(container.querySelector(".lucide")).toBeTruthy();
    expect(dismissButton()).toBeTruthy();
  });

  it("keeps the face flat: hairline, no elevation cast", async () => {
    await renderCard();

    const card = container.querySelector('[role="note"]');
    if (!(card instanceof HTMLElement)) {
      throw new Error("Card not found");
    }
    // The row separates by its level1 face and 1px hairline — in-flow tips
    // must not borrow the floating-layer `premiumSurface` cast. jsdom reports
    // an undeclared box-shadow as "" rather than "none".
    expect(getComputedStyle(card).borderTopWidth).toBe("1px");
    expect(["", "none"]).toContain(getComputedStyle(card).boxShadow);
  });

  it("renders no action for a tip anchored on its own feature page", async () => {
    await renderCard();

    // `review-before-insert` is passed no `action`, so only the dismiss
    // control is present — the page below the tip is the feature.
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

  it("runs the in-page action", async () => {
    const onAction = vi.fn();
    await renderCard({
      id: "generative-provider",
      action: { label: "Add API key", onAction },
    });

    expect(container.textContent).toContain("Add an AI provider for polishing");
    act(() => {
      buttonWithText("Add API key").click();
    });

    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("TipCardFrame", () => {
  const frameCard = (): HTMLElement => {
    const target = container.querySelector('[role="note"]');
    if (!(target instanceof HTMLElement)) {
      throw new Error("Card not found in frame");
    }
    return target;
  };

  const renderFrame = (
    props: Parameters<typeof TipCardFrame>[0] &
      Partial<Parameters<typeof TipCardFrame>[0]>,
  ) =>
    act(async () => {
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
});
