// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

const h = vi.hoisted(() => ({
  state: { local: { dismissedTipIds: [] as string[] } },
  resetTip: vi.fn(),
}));

vi.mock("../../store", () => ({
  useAppStore: (selector: (s: unknown) => unknown) => selector(h.state),
}));

vi.mock("../../actions/onboarding.actions", () => ({
  resetTip: h.resetTip,
}));

import HelpPage from "./HelpPage";

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

/** The tip cards `TipCardFrame` renders, one per onboarding tip, in order. */
const tipCards = (): HTMLElement[] =>
  [...container.querySelectorAll<HTMLElement>(".MuiBox-root")].filter(
    (element) => getComputedStyle(element).borderTopWidth === "1px",
  );

const dimmedCards = (): HTMLElement[] =>
  tipCards().filter((card) => getComputedStyle(card).opacity !== "1");

const showAgainCount = (): number =>
  [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Show again",
  ).length;

const renderPage = async () => {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(HelpPage)));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.local.dismissedTipIds = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HelpPage tip cards", () => {
  it("dims exactly the tips the user has dismissed", async () => {
    h.state.local.dismissedTipIds = ["writing-styles", "update-channel"];
    await renderPage();

    // The dimming is the only signal that a tip was dismissed: this list is
    // where dismissed tips are browsed, so a card that looks identical to a live
    // one leaves the user no way to tell them apart. "Show again" is rendered
    // only for a dismissed tip, so its count pins the expectation without
    // depending on which tips come first.
    expect(showAgainCount()).toBe(2);
    expect(dimmedCards()).toHaveLength(2);
    expect(getComputedStyle(dimmedCards()[0]).opacity).toBe("0.65");
  });

  it("dims a single dismissed tip and no other", async () => {
    h.state.local.dismissedTipIds = ["writing-styles"];
    await renderPage();

    expect(showAgainCount()).toBe(1);
    expect(dimmedCards()).toHaveLength(1);
    expect(tipCards()).toHaveLength(5);
  });

  it("dims nothing when no tip has been dismissed", async () => {
    await renderPage();

    expect(dimmedCards()).toHaveLength(0);
    expect(tipCards().map((card) => getComputedStyle(card).opacity)).toEqual(
      tipCards().map(() => "1"),
    );
  });
});
