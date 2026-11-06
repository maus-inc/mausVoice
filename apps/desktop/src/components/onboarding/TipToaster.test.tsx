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

// jsdom cannot play the real exit animation, so the presence wrapper keeps
// the removed child mounted (as the real library does while it exits) and
// reports completion one tick later — the same contract `TipCard`'s deferred
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

import { TipToaster } from "./TipToaster";
import { setTipAction } from "./tip-actions";

ensureUiHarness();
setMatchMedia(false);

let container: HTMLDivElement;
let root: Root | null;

const renderToaster = (path: string) =>
  act(() => {
    root?.render(
      createElement(
        ThemeProvider,
        { theme, ...THEME_PROVIDER_CONFIG },
        createElement(
          MemoryRouter,
          { initialEntries: [path] },
          createElement(TipToaster),
        ),
      ),
    );
  });

/** The fixed corner stack: the only fixed-position element the toaster adds. */
const stack = (): HTMLElement => {
  const found = Array.from(document.body.children).find(
    (el) =>
      el instanceof HTMLElement && getComputedStyle(el).position === "fixed",
  );
  if (!(found instanceof HTMLElement)) {
    throw new Error("Tip stack not found");
  }
  return found;
};

const noteCount = () => document.querySelectorAll('[role="note"]').length;

/**
 * The dismiss control sits on the card's pattern-image header
 * (`data-tip-card`), a sibling of the `role="note"` row `TipCardFrame`
 * renders for the icon, title, and body, not a descendant of it.
 */
const dismissButtonIn = (titleText: string): HTMLButtonElement => {
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>('[data-tip-card="true"]'),
  );
  const card = cards.find((c) => c.textContent?.includes(titleText));
  const button = card?.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss tip"]',
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Dismiss control for "${titleText}" not found`);
  }
  return button;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.local.dismissedTipIds = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = "";
});

describe("TipToaster", () => {
  it("shows the route's tip on the styling route", async () => {
    await renderToaster("/dashboard/styling");

    expect(noteCount()).toBe(1);
    expect(document.body.textContent).toContain(
      "Teach mausVoice how you write",
    );
  });

  it("matches the route even with a trailing slash", async () => {
    // React Router renders existing routes with a trailing slash and keeps
    // it in `pathname`; the match must still hold or the tip hides there.
    await renderToaster("/dashboard/styling/");

    expect(noteCount()).toBe(1);
    expect(document.body.textContent).toContain(
      "Teach mausVoice how you write",
    );
  });

  it("shows nothing on a route with no tip", async () => {
    await renderToaster("/dashboard/help");

    expect(noteCount()).toBe(0);
  });

  it("shows the AI-provider tip on the AI models page", async () => {
    await renderToaster("/dashboard/settings/ai-models");

    expect(noteCount()).toBe(1);
    expect(document.body.textContent).toContain(
      "Add an AI provider for polishing",
    );
  });

  it("shows the update-channel tip on the system page, not the AI models page", async () => {
    // The settings surface is routed, so each tip anchors to the page where
    // its feature lives rather than stacking both on the bare settings route.
    await renderToaster("/dashboard/settings/system");

    expect(noteCount()).toBe(1);
    expect(document.body.textContent).toContain("Try beta builds early");
  });

  it("hides a dismissed tip", async () => {
    mocks.state.local.dismissedTipIds = ["writing-styles"];
    await renderToaster("/dashboard/styling");

    expect(noteCount()).toBe(0);
  });

  it("anchors the stack to the bottom-right corner, under overlays", async () => {
    await renderToaster("/dashboard/styling");

    const style = getComputedStyle(stack());
    expect(style.position).toBe("fixed");
    expect(style.right).toBe("16px");
    expect(style.bottom).toBe("16px");
    // Below the transient Sonner toasts and the MUI overlay surfaces, above
    // the page content: a toast may sit on a tip, a tip never on a toast.
    expect(style.zIndex).toBe("1100");
  });

  it("persists the dismissal once the exit finishes and clears the slot", async () => {
    await renderToaster("/dashboard/styling");

    act(() => {
      dismissButtonIn("Teach mausVoice how you write").click();
    });
    expect(mocks.dismissTip).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(mocks.dismissTip).toHaveBeenCalledWith("writing-styles");
    });
    // The store mock is not subscribed live, so mirror the persistence it
    // recorded and re-render: with the id dismissed, the slot clears.
    mocks.state.local.dismissedTipIds = ["writing-styles"];
    await renderToaster("/dashboard/styling");
    expect(noteCount()).toBe(0);
  });

  it("persists the dismissal if the route changes mid-exit", async () => {
    await renderToaster("/dashboard/styling");

    act(() => {
      dismissButtonIn("Teach mausVoice how you write").click();
    });
    expect(mocks.dismissTip).not.toHaveBeenCalled();

    // Navigating away unmounts the toaster's tip mid-exit; the choice must
    // still persist or the tip reappears on the next visit.
    act(() => root?.unmount());

    expect(mocks.dismissTip).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTip).toHaveBeenCalledWith("writing-styles");
  });

  it("runs the in-page action without consuming the tip", async () => {
    const onAction = vi.fn();
    const unregister = setTipAction("generative-provider", onAction);
    try {
      await renderToaster("/dashboard/settings/ai-models");

      const addButton = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((b) => b.textContent === "Add API key");
      expect(addButton).toBeTruthy();
      act(() => {
        addButton?.click();
      });

      expect(onAction).toHaveBeenCalledTimes(1);
      expect(mocks.dismissTip).not.toHaveBeenCalled();
      // The action completes the task; the tip stays on screen.
      expect(noteCount()).toBe(1);
    } finally {
      unregister();
    }
  });
});
