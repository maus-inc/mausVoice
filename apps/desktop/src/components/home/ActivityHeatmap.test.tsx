// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material/styles";
import { theme } from "../../theme";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { getActivityDateRange } from "../../utils/activity-grid.utils";
import type { HomeActivityState } from "./home.types";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

const testDate = new Date(2026, 9, 6, 12);
const range = getActivityDateRange(testDate);
const records = [
  { localDate: "2026-10-05", wordCount: 31 },
  { localDate: range.endDate, wordCount: 45 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const renderActivity = (overrides: Partial<HomeActivityState> = {}) => {
  const state: HomeActivityState = {
    status: "ready",
    records,
    ...range,
    hasLoaded: true,
    ...overrides,
  };
  act(() => {
    root.render(
      createElement(
        IntlProvider,
        { locale: "en" },
        createElement(
          ThemeProvider,
          { theme },
          createElement(ActivityHeatmap, state),
        ),
      ),
    );
  });
};

const activityGrid = () =>
  container.querySelector<HTMLElement>('[role="grid"]');

describe("ActivityHeatmap", () => {
  it("exposes one composite calendar with full local date and word-count labels", () => {
    renderActivity();

    const grid = activityGrid();
    expect(grid?.getAttribute("tabindex")).toBe("0");
    expect(grid?.getAttribute("aria-activedescendant")).toContain(
      range.endDate,
    );
    expect(container.querySelectorAll('[role="gridcell"]')).toHaveLength(177);
    expect(container.querySelector('[role="gridcell"][tabindex]')).toBeNull();
    expect(container.textContent).toContain("Tuesday, October 6, 2026");
    expect(container.textContent).toContain("45 saved words so far today");
    expect(container.textContent).toContain("Relative to this 26-week period");
  });

  it("moves the single active descendant with arrow keys and exposes exact details", () => {
    renderActivity();
    const grid = activityGrid();
    if (!grid) throw new Error("Expected the activity calendar grid");

    act(() => {
      grid.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(grid.getAttribute("aria-activedescendant")).toContain("2026-09-29");
    expect(container.textContent).toContain("Tuesday, September 29, 2026");

    const viewDetails = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("View activity details"),
    );
    if (!viewDetails) throw new Error("Expected the activity details control");
    act(() => viewDetails.click());

    expect(viewDetails.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[aria-label="Daily saved-word details"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Monday, October 5, 2026");
    expect(container.textContent).toContain("31");
  });

  it("distinguishes loading, empty, and query-error states", () => {
    renderActivity({
      status: "loading",
      records: [],
      hasLoaded: false,
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(activityGrid()).toBeNull();

    renderActivity({ status: "ready", records: [], hasLoaded: true });
    expect(activityGrid()).not.toBeNull();
    expect(container.textContent).toContain(
      "No saved-word activity is represented for this period.",
    );
    expect(container.textContent).toContain(
      "A zero means no words are represented here—not proof that you didn't dictate.",
    );

    renderActivity({ status: "error", records: [], hasLoaded: false });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "We couldn't load saved-word activity.",
    );
    expect(activityGrid()).toBeNull();
  });

  it("keeps the last successful series visible after a refresh failure", () => {
    renderActivity({ status: "error", records, hasLoaded: true });

    expect(container.querySelector('[role="grid"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "Activity couldn't refresh. Showing the last successful result.",
    );
    expect(container.textContent).toContain("45 saved words so far today");
  });
});
