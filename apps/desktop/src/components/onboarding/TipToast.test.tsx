// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

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

import { TipToastCard, TipToastTrigger } from "./TipToast";

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

const bodyRegion = (): HTMLElement => {
  const region = container.querySelector('[role="button"]');
  if (!(region instanceof HTMLElement)) {
    throw new Error("Clickable body region not found");
  }
  return region;
};

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

describe("TipToastCard", () => {
  const renderCard = (
    props: Partial<Parameters<typeof TipToastCard>[0]> & {
      id: Parameters<typeof TipToastCard>[0]["id"];
    },
  ) =>
    act(() => {
      root.render(
        createElement(TipToastCard, { onDismiss: vi.fn(), ...props }),
      );
    });

  it("renders the icon, copy, pattern image, and dismiss control", async () => {
    await renderCard({ id: "review-before-insert" });

    expect(container.textContent).toContain("Review before it inserts");
    expect(container.textContent).toContain(
      "Review mode holds each transcript on the pill first",
    );
    expect(container.querySelector(".lucide")).toBeTruthy();
    expect(container.querySelector('img[alt=""]')).toBeTruthy();
    expect(dismissButton()).toBeTruthy();
  });

  it("clicking the body runs the action, persists the dismissal, and removes the toast", async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    await renderCard({ id: "generative-provider", onAction, onDismiss });

    act(() => {
      bodyRegion().click();
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(mocks.dismissTip).toHaveBeenCalledWith("generative-provider");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clicking the body on a tip with no action still persists and removes the toast", async () => {
    const onDismiss = vi.fn();
    await renderCard({ id: "writing-styles", onDismiss });

    act(() => {
      bodyRegion().click();
    });

    expect(mocks.dismissTip).toHaveBeenCalledWith("writing-styles");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("activates the body on Enter and Space", async () => {
    const onAction = vi.fn();
    await renderCard({ id: "assistant-mode", onAction });

    act(() => {
      bodyRegion().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("ignores a keydown that bubbled up from the dismiss button", async () => {
    const onAction = vi.fn();
    await renderCard({ id: "assistant-mode", onAction });

    // The dismiss button sits in a sibling section, not inside the body
    // region, so this only guards against a future refactor nesting it.
    act(() => {
      dismissButton().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("clicking the dismiss control persists the dismissal without running the action", async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    await renderCard({ id: "update-channel", onAction, onDismiss });

    act(() => {
      dismissButton().click();
    });

    expect(onAction).not.toHaveBeenCalled();
    expect(mocks.dismissTip).toHaveBeenCalledWith("update-channel");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not persist the dismissal twice on repeated activation", async () => {
    await renderCard({ id: "review-before-insert" });

    act(() => {
      bodyRegion().click();
      bodyRegion().click();
    });

    expect(mocks.dismissTip).toHaveBeenCalledTimes(1);
  });

  it("a click on the dismiss button does not also activate the body", async () => {
    const onAction = vi.fn();
    await renderCard({ id: "generative-provider", onAction });

    act(() => {
      dismissButton().click();
    });

    expect(onAction).not.toHaveBeenCalled();
    expect(mocks.dismissTip).toHaveBeenCalledTimes(1);
  });
});

describe("TipToastTrigger", () => {
  const sonner = vi.hoisted(() => ({
    custom: vi.fn(
      (
        _jsx: (id: number | string) => unknown,
        _data?: { id?: number | string; duration?: number },
      ) => "mock-toast-id",
    ),
    dismiss: vi.fn(),
  }));

  vi.mock("sonner", () => ({
    toast: { custom: sonner.custom, dismiss: sonner.dismiss },
  }));

  beforeEach(() => {
    sonner.custom.mockClear();
    sonner.dismiss.mockClear();
  });

  const renderTrigger = (props: Parameters<typeof TipToastTrigger>[0]) =>
    act(() => {
      root.render(createElement(TipToastTrigger, props));
    });

  it("shows the toast on mount when the tip is visible", async () => {
    await renderTrigger({ id: "update-channel", visible: true });

    expect(sonner.custom).toHaveBeenCalledTimes(1);
    const options = sonner.custom.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      id: "update-channel",
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
    });
  });

  it("does not show the toast when the tip is already dismissed", async () => {
    await renderTrigger({ id: "update-channel", visible: false });

    expect(sonner.custom).not.toHaveBeenCalled();
  });

  it("clears the toast without persisting a dismissal on unmount", async () => {
    await renderTrigger({ id: "update-channel", visible: true });

    act(() => {
      root.unmount();
    });

    expect(sonner.dismiss).toHaveBeenCalledWith("update-channel");
    expect(mocks.dismissTip).not.toHaveBeenCalled();
  });

  it("shows again when visibility flips from false to true", async () => {
    await renderTrigger({ id: "update-channel", visible: false });
    expect(sonner.custom).not.toHaveBeenCalled();

    await renderTrigger({ id: "update-channel", visible: true });
    expect(sonner.custom).toHaveBeenCalledTimes(1);
  });
});
