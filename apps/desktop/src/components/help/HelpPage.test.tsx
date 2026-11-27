// @vitest-environment jsdom
import { act, createElement } from "react";
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
  resetTip: vi.fn(),
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(mocks.state),
}));

vi.mock("../../actions/onboarding.actions", () => ({
  resetTip: mocks.resetTip,
}));

import { TipCardFrame } from "../onboarding/TipCard";
import HelpPage from "./HelpPage";

ensureUiHarness();
setMatchMedia(false);

let container: HTMLDivElement;
let root: Root;

/** The tip cards `TipCardFrame` renders, one per onboarding tip, in order. */
const tipCards = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-tip-frame="true"]'),
];

const recessedCards = (): HTMLElement[] =>
  tipCards().filter(
    (card) => getComputedStyle(card).borderTopStyle === "dashed",
  );

const showAgainButtons = (): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent === "Show again",
  );

const renderPage = async () => {
  await act(async () => {
    root.render(
      createElement(
        ThemeProvider,
        { theme, ...THEME_PROVIDER_CONFIG },
        createElement(MemoryRouter, null, createElement(HelpPage)),
      ),
    );
  });
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

describe("HelpPage tip cards", () => {
  it("allows contextual tip headings without changing their appearance variant", () => {
    act(() =>
      root.render(
        createElement(TipCardFrame, {
          title: "Tip",
          body: "Body",
          headingLevel: "h3",
        }),
      ),
    );
    const heading = container.querySelector("h3");
    expect(heading?.textContent).toBe("Tip");
    expect(heading?.classList.contains("MuiTypography-titleSmall")).toBe(true);
  });

  it("does not invent a heading level for a standalone tip", () => {
    act(() =>
      root.render(createElement(TipCardFrame, { title: "Tip", body: "Body" })),
    );
    expect(container.querySelector(".MuiTypography-titleSmall")?.tagName).toBe(
      "P",
    );
  });

  it("uses the shared dashboard heading scale and second-level headings for tips", async () => {
    await renderPage();
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Help and onboarding");
    expect(heading?.classList.contains("MuiTypography-h4")).toBe(true);
    expect(container.querySelectorAll("h2")).toHaveLength(5);
  });

  it("centers content in the shared small dashboard container without a nested scroll wrapper", async () => {
    await renderPage();
    const layoutContainer = container.querySelector(".MuiContainer-maxWidthSm");
    expect(layoutContainer).not.toBeNull();
    expect(layoutContainer?.contains(container.querySelector("h1"))).toBe(true);
    expect(tipCards().every((card) => layoutContainer?.contains(card))).toBe(
      true,
    );

    const hasNestedScrollContainer = [
      ...container.querySelectorAll<HTMLElement>("*"),
    ].some((element) => {
      const style = getComputedStyle(element);
      return (
        style.overflow === "auto" ||
        style.overflowY === "auto" ||
        style.overflow === "scroll" ||
        style.overflowY === "scroll"
      );
    });
    expect(hasNestedScrollContainer).toBe(false);
  });

  it("renders the supporting description in secondary text color", async () => {
    await renderPage();
    const subtitle = container.querySelector(".MuiTypography-subtitle1");
    expect(subtitle).not.toBeNull();
    expect(getComputedStyle(subtitle as HTMLElement).color).toBe(
      "var(--app-palette-text-secondary)",
    );
  });

  it("distinguishes dismissed tips with a recessed dashed frame at full opacity", async () => {
    mocks.state.local.dismissedTipIds = ["writing-styles", "update-channel"];
    await renderPage();

    expect(showAgainButtons()).toHaveLength(2);
    expect(recessedCards()).toHaveLength(2);
    for (const card of recessedCards()) {
      const style = getComputedStyle(card);
      expect(style.borderTopStyle).toBe("dashed");
      expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      // Full opacity keeps secondary copy and action buttons readable instead
      // of multiplying text alpha below WCAG AA contrast.
      expect(style.opacity).toBe("1");
      const icon = card.querySelector<HTMLElement>('[data-tip-icon="true"]');
      expect(icon).not.toBeNull();
      expect(getComputedStyle(icon as HTMLElement).opacity).toBe("1");
    }

    const activeCards = tipCards().filter(
      (card) => getComputedStyle(card).borderTopStyle === "solid",
    );
    expect(activeCards).toHaveLength(3);
  });

  it("marks only the single dismissed tip recessed and wires Show again to resetTip", async () => {
    mocks.state.local.dismissedTipIds = ["writing-styles"];
    await renderPage();

    expect(showAgainButtons()).toHaveLength(1);
    expect(recessedCards()).toHaveLength(1);
    expect(tipCards()).toHaveLength(5);

    act(() => {
      showAgainButtons()[0].click();
    });
    expect(mocks.resetTip).toHaveBeenCalledTimes(1);
    expect(mocks.resetTip).toHaveBeenCalledWith("writing-styles");
  });

  it("keeps every card active when no tip has been dismissed", async () => {
    await renderPage();

    expect(showAgainButtons()).toHaveLength(0);
    expect(recessedCards()).toHaveLength(0);
    expect(
      tipCards().map((card) => getComputedStyle(card).borderTopStyle),
    ).toEqual(tipCards().map(() => "solid"));
  });
});
