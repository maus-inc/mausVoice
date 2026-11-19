// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider, createTheme } from "@mui/material";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "react-intl";

const { useIsDarkModeMock } = vi.hoisted(() => ({
  useIsDarkModeMock: vi.fn(() => false),
}));

vi.mock("../../hooks/color-scheme.hooks", () => ({
  useIsDarkMode: useIsDarkModeMock,
}));
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import en from "../../i18n/locales/en.json";
import { activityHeatmapGeometry } from "../../styles/activity-heatmap";
import { ActivityHeatmap } from "./ActivityHeatmap";

ensureUiHarness();

describe("ActivityHeatmap", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootUnmounted: boolean;

  beforeEach(() => {
    rootUnmounted = false;
    useIsDarkModeMock.mockReturnValue(false);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (!rootUnmounted) act(() => root.unmount());
    container.remove();
  });

  const renderHeatmap = (
    wordCount: number,
    status: "success" | "loading" = "success",
    dark = false,
  ) => {
    useIsDarkModeMock.mockReturnValue(dark);
    act(() => {
      root.render(
        <IntlProvider locale="en" messages={en}>
          <ThemeProvider theme={createTheme()}>
            <ActivityHeatmap
              activity={
                wordCount > 0 ? [{ localDate: "2026-10-08", wordCount }] : []
              }
              status={status}
              today={new Date(2026, 9, 8, 12)}
            />
          </ThemeProvider>
        </IntlProvider>,
      );
    });
  };

  it("uses the compact reference geometry for its year grid", () => {
    expect(activityHeatmapGeometry).toEqual({
      cellSize: 10,
      cellGap: 4,
      labelColumnWidth: 22,
      desktopLabelColumnWidth: 13,
      dayGridWidth: 738,
      desktopRightInset: 9,
      desktopTopPadding: 30,
      viewportWidth: 274,
    });
  });

  it("opens on the current weeks while keeping older activity scrollable", () => {
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(activityHeatmapGeometry.dayGridWidth);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(
        activityHeatmapGeometry.viewportWidth -
          activityHeatmapGeometry.labelColumnWidth -
          activityHeatmapGeometry.cellGap,
      );

    try {
      renderHeatmap(5);

      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="activity-heatmap-viewport"]',
      );
      const weekdayRail = container.querySelector<HTMLElement>(
        '[data-testid="activity-heatmap-labels"]',
      );
      const weekdayLabel = weekdayRail?.querySelector<HTMLElement>(
        '[aria-hidden="true"]',
      );

      expect(viewport?.scrollLeft).toBe(490);
      expect(viewport?.getAttribute("role")).toBe("region");
      expect(viewport?.getAttribute("aria-labelledby")).toBe(
        "home-activity-heading",
      );
      expect(viewport?.tabIndex).toBe(0);
      expect(window.getComputedStyle(viewport!).overflowX).toBe("auto");
      expect(weekdayRail).not.toBeNull();
      expect(viewport?.contains(weekdayRail)).toBe(false);
      expect(weekdayRail?.nextElementSibling).toBe(viewport);
      expect(
        viewport?.querySelectorAll('[role="img"] [data-testid="activity-day"]'),
      ).toHaveLength(371);
      expect(window.getComputedStyle(weekdayLabel!).position).not.toBe(
        "sticky",
      );
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("follows the latest week after resizing until the reader scrolls into history", () => {
    let viewportWidth = 248;
    let notifyResize: (() => void) | undefined;
    let observedTarget: Element | undefined;
    const disconnect = vi.fn();

    class MockResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe = vi.fn((target: Element) => {
        observedTarget = target;
        notifyResize = () =>
          this.callback([], this as unknown as ResizeObserver);
      });
      disconnect = disconnect;
    }

    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const scrollWidth = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(activityHeatmapGeometry.dayGridWidth);
    const clientWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockImplementation(() => viewportWidth);

    try {
      renderHeatmap(5);

      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="activity-heatmap-viewport"]',
      );
      expect(observedTarget).toBe(viewport);
      expect(notifyResize).toBeDefined();
      expect(viewport?.scrollLeft).toBe(490);

      viewportWidth = 226;
      act(() => notifyResize?.());
      expect(viewport?.scrollLeft).toBe(512);

      act(() => {
        viewport!.scrollLeft = 100;
        viewport!.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      viewportWidth = 210;
      act(() => notifyResize?.());
      expect(viewport?.scrollLeft).toBe(100);

      act(() => root.unmount());
      rootUnmounted = true;
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it("uses the singular label and accessible summary for one active day", () => {
    renderHeatmap(5);

    expect(container.textContent).toContain("1 active day");
    expect(
      container.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Daily word activity: 1 active day and 5 words in the past year.");
  });

  it("uses the reference weekday labels and keeps them screen-reader friendly", () => {
    renderHeatmap(5);

    const weekdayLabels = Array.from(
      container.querySelectorAll(
        '[data-testid="activity-heatmap-labels"] [aria-hidden="true"]',
      ),
    )
      .filter(
        (element) => window.getComputedStyle(element).visibility !== "hidden",
      )
      .map((element) => element.textContent ?? "")
      .filter(Boolean);

    expect(weekdayLabels).toEqual(["M", "W", "F", "S"]);
    const styles = Array.from(
      document.querySelectorAll("style[data-emotion]"),
      (style) => style.textContent ?? "",
    )
      .join("\n")
      .toLowerCase();
    expect(styles).toContain("font-family:var(--font-data)");
    expect(
      container.querySelectorAll('[data-testid="activity-day"]'),
    ).toHaveLength(371);
    expect(
      container.querySelectorAll(
        '[aria-label="Activity level legend"] [aria-hidden="true"]',
      ),
    ).toHaveLength(3);
  });

  it("uses the dark activity ramp when the resolved scheme is dark", () => {
    renderHeatmap(5, "success", true);

    const styles = Array.from(
      document.querySelectorAll("style[data-emotion]"),
      (style) => style.textContent ?? "",
    )
      .join("\n")
      .toLowerCase();

    expect(styles).toContain("#281c14");
    expect(styles).toContain("#ef8f50");
  });

  it("adds a brief pointer emphasis and disables scale motion when reduced motion is preferred", () => {
    renderHeatmap(5);

    const styles = Array.from(
      document.querySelectorAll("style[data-emotion]"),
      (style) => style.textContent ?? "",
    )
      .join("\n")
      .replace(/\s+/g, "");

    expect(styles).toContain("@media(hover:hover)and(pointer:fine)");
    expect(styles).toContain("scale(1.35)");
    expect(styles).toContain("@media(prefers-reduced-motion:reduce)");
    expect(styles).toContain("transform:none");
  });

  it("does not report zero activity before the initial load completes", () => {
    renderHeatmap(0, "loading");

    expect(container.textContent).not.toContain("0 active days");
    expect(
      container.querySelector('[aria-label="Loading daily activity"]'),
    ).not.toBeNull();
  });

  it("uses the plural label and accessible summary when there is no activity", () => {
    renderHeatmap(0);

    expect(container.textContent).toContain("0 active days");
    expect(
      container.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Daily word activity: 0 active days and 0 words in the past year.");
    const accessibleList = container.querySelector(
      '[aria-label="Daily word counts"]',
    );
    expect(accessibleList).not.toBeNull();
    if (accessibleList === null) return;
    expect(window.getComputedStyle(accessibleList).width).toBe("1px");
    expect(window.getComputedStyle(accessibleList).height).toBe("1px");
  });
});
