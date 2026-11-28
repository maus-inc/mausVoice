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
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import de from "../../i18n/locales/de.json";
import en from "../../i18n/locales/en.json";
import { activityHeatmapGeometry } from "../../styles/activity-heatmap";
import {
  duration,
  reducedMotionQuery,
  skeletonPulse,
} from "../../styles/motion";
import { activityHeatmapSkeleton } from "../../styles/palette";
import type {
  DailyActivityStatus,
  DailyWordActivity,
} from "../../types/home.types";
import { ACTIVITY_HEATMAP_WEEKS } from "../../utils/activity-grid.utils";
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
    vi.useRealTimers();
    setMatchMedia(false);
    container.remove();
  });

  const renderHeatmap = (
    wordCount: number,
    status: DailyActivityStatus = "success",
    dark = false,
    locale = "en",
    messages: Record<string, string> = en,
  ) => {
    useIsDarkModeMock.mockReturnValue(dark);
    act(() => {
      root.render(
        <IntlProvider locale={locale} messages={messages}>
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

  const renderActivity = (activity: DailyWordActivity[]) => {
    useIsDarkModeMock.mockReturnValue(false);
    act(() => {
      root.render(
        <IntlProvider locale="en" messages={en}>
          <ThemeProvider theme={createTheme()}>
            <ActivityHeatmap
              activity={activity}
              status="success"
              today={new Date(2026, 9, 8, 12)}
            />
          </ThemeProvider>
        </IntlProvider>,
      );
    });
  };

  const openTooltipTexts = () =>
    Array.from(document.querySelectorAll('[role="tooltip"]'), (el) =>
      el.textContent?.trim(),
    );

  const getActivityCell = (date: string) =>
    container.querySelector<HTMLElement>(
      `[data-testid="activity-day"][data-date="${date}"]`,
    );

  it("uses the compact reference geometry for its year grid", () => {
    expect(activityHeatmapGeometry).toEqual({
      cellSize: 10,
      cellGap: 4,
      labelColumnWidth: 22,
      desktopLabelColumnWidth: 13,
      dayGridWidth: 738,
      cellHoverScale: 1.35,
      cellHoverReach: 5,
      desktopRightInset: 9,
      desktopTopPadding: 30,
      viewportWidth: 274,
    });
  });

  it("reserves room on every viewport edge for a hovered edge cell", () => {
    renderHeatmap(5);

    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-viewport"]',
    );
    const weekdayRail = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-labels"]',
    );
    expect(viewport).not.toBeNull();
    expect(weekdayRail).not.toBeNull();

    // A cell grows past each side of its box by half the hover growth and
    // draws its ring on that same transformed element, so the ring's own
    // inset grows with the cell. This is the clearance the whole treatment
    // needs, derived from the geometry the component renders so a retuned
    // cell size or scale cannot leave the padding behind.
    const needed = Math.ceil(
      (activityHeatmapGeometry.cellSize *
        (activityHeatmapGeometry.cellHoverScale - 1)) /
        2 +
        2 * activityHeatmapGeometry.cellHoverScale,
    );
    const viewportStyle = window.getComputedStyle(viewport!);
    for (const side of [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
    ] as const) {
      expect(parseFloat(viewportStyle[side])).toBeGreaterThanOrEqual(needed);
    }
    expect(viewportStyle.overflowY).toBe("clip");
    expect(viewportStyle.overflowX).toBe("auto");

    // Only the viewport scrolls and clips. A wrapper or an inner div that
    // clipped the rows again would defeat the room reserved above, and that is
    // invisible to a jsdom box model, so assert no other clip exists on the
    // path between the viewport and a cell.
    expect(viewport!.querySelectorAll("*")).not.toHaveLength(0);
    for (const box of viewport!.querySelectorAll("*")) {
      expect(window.getComputedStyle(box).overflowY).toBe("visible");
    }

    // The rail sits beside the plot, so it carries the same top offset and the
    // weekday labels stay level with their rows.
    expect(parseFloat(window.getComputedStyle(weekdayRail!).paddingTop)).toBe(
      parseFloat(viewportStyle.paddingTop),
    );
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
    expect(styles).toContain(
      `scale(${activityHeatmapGeometry.cellHoverScale})`,
    );
    expect(styles).toContain("@media(prefers-reduced-motion:reduce)");
    expect(styles).toContain("transform:none");
    // The reduced-motion branch cancels the scale, so the clearance the
    // viewport reserves is never needed and never removed either.
    expect(styles).toContain(
      `padding:${activityHeatmapGeometry.cellHoverReach}px`,
    );
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

  it("keeps tooltips non-interactive so they cannot trap pointer sweeps over neighboring cells", () => {
    vi.useFakeTimers();
    renderActivity([
      { localDate: "2026-10-08", wordCount: 120 },
      { localDate: "2026-10-07", wordCount: 45 },
    ]);

    const oct8 = getActivityCell("2026-10-08");
    expect(oct8).not.toBeNull();
    if (oct8 === null) return;

    act(() => {
      oct8.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    if (tooltip === null) return;
    expect(tooltip.textContent).toBe("Oct 8, 2026: 120 words");
    expect(tooltip.classList.contains("MuiTooltip-popperInteractive")).toBe(
      false,
    );
    expect(window.getComputedStyle(tooltip).pointerEvents).toBe("none");
    const tooltipContent = tooltip.querySelector<HTMLElement>(
      ".MuiTooltip-tooltip",
    );
    expect(tooltipContent?.style.transition).toContain(
      `${duration.instant * 1000}ms`,
    );

    // Moving off the cell onto the tooltip's screen position must still close it.
    act(() => {
      oct8.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: tooltip }),
      );
      tooltip.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: oct8 }),
      );
      vi.advanceTimersByTime(0);
    });

    expect(openTooltipTexts()).toEqual([]);
  });

  it("switches immediately between adjacent cells without overlapping tooltips and closes on leave", () => {
    vi.useFakeTimers();
    renderActivity([
      { localDate: "2026-10-08", wordCount: 120 },
      { localDate: "2026-10-07", wordCount: 45 },
      { localDate: "2026-10-06", wordCount: 0 },
    ]);

    const oct8 = getActivityCell("2026-10-08");
    const oct7 = getActivityCell("2026-10-07");
    const oct6 = getActivityCell("2026-10-06");
    expect(oct8).not.toBeNull();
    expect(oct7).not.toBeNull();
    expect(oct6).not.toBeNull();
    if (!oct8 || !oct7 || !oct6) return;

    act(() => {
      oct8.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(openTooltipTexts()).toEqual(["Oct 8, 2026: 120 words"]);

    act(() => {
      oct8.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: oct7 }),
      );
      oct7.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: oct8 }),
      );
      vi.advanceTimersByTime(0);
    });
    expect(openTooltipTexts()).toEqual(["Oct 7, 2026: 45 words"]);

    act(() => {
      oct7.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: oct6 }),
      );
      oct6.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: oct7 }),
      );
      vi.advanceTimersByTime(0);
    });
    expect(openTooltipTexts()).toEqual(["Oct 6, 2026: 0 words"]);

    act(() => {
      oct6.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      vi.advanceTimersByTime(0);
    });
    expect(openTooltipTexts()).toEqual([]);
  });

  it("preserves Escape dismissal, touch long-press, future-cell suppression, keyboard focus, and reduced motion", () => {
    vi.useFakeTimers();
    setMatchMedia((query) => query === reducedMotionQuery);
    renderActivity([{ localDate: "2026-10-08", wordCount: 120 }]);

    const viewport = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-viewport"]',
    );
    expect(viewport?.tabIndex).toBe(0);
    expect(
      container.querySelector('[aria-label="Daily word counts"]'),
    ).not.toBeNull();

    const oct8 = getActivityCell("2026-10-08");
    const oct9Future = getActivityCell("2026-10-09");
    expect(oct8).not.toBeNull();
    expect(oct9Future).not.toBeNull();
    if (!oct8 || !oct9Future) return;

    act(() => {
      oct9Future.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    expect(openTooltipTexts()).toEqual([]);

    act(() => {
      oct8.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const tooltipPopper =
      document.querySelector<HTMLElement>('[role="tooltip"]');
    const tooltipContent = tooltipPopper?.querySelector<HTMLElement>(
      ".MuiTooltip-tooltip",
    );
    expect(tooltipPopper).not.toBeNull();
    expect(tooltipContent).not.toBeNull();
    if (!tooltipPopper || !tooltipContent) return;
    // Keeping the enter transition mounted with a 0ms timeout preserves
    // Popper's onEnter positioning hook while removing enter animation.
    expect(tooltipPopper.getAttribute("data-popper-placement")).toBe("top");
    expect(tooltipContent.style.transition).toContain("0ms");
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(tooltipContent.style.opacity).toBe("1");
    expect(tooltipContent.style.transform).toBe("none");

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(openTooltipTexts()).toEqual([]);

    // Touch long-press still opens and closes on the default MUI touch schedule.
    act(() => {
      oct8.dispatchEvent(new Event("touchstart", { bubbles: true }));
      vi.advanceTimersByTime(700);
    });
    expect(openTooltipTexts()).toEqual(["Oct 8, 2026: 120 words"]);

    act(() => {
      oct8.dispatchEvent(new Event("touchend", { bubbles: true }));
      vi.advanceTimersByTime(1500);
    });
    expect(openTooltipTexts()).toEqual([]);
  });

  it.each(["idle", "loading"] as const)(
    "renders a geometry-matched skeleton instead of LinearProgress for %s status",
    (status) => {
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
        renderHeatmap(0, status);

        const section = container.querySelector<HTMLElement>(
          '[data-testid="home-activity-heatmap"]',
        );
        const skeleton = container.querySelector<HTMLElement>(
          '[data-testid="activity-heatmap-skeleton"]',
        );
        const weekdayRail = container.querySelector<HTMLElement>(
          '[data-testid="activity-heatmap-labels"]',
        );
        const viewport = container.querySelector<HTMLElement>(
          '[data-testid="activity-heatmap-viewport"]',
        );
        const skeletonGrid = container.querySelector<HTMLElement>(
          '[data-testid="activity-heatmap-skeleton-grid"]',
        );
        const skeletonCells = container.querySelectorAll<HTMLElement>(
          '[data-testid="activity-heatmap-skeleton-cell"]',
        );
        const legendSkeleton = container.querySelector<HTMLElement>(
          '[data-testid="activity-heatmap-legend-skeleton"]',
        );
        const legendSwatches = container.querySelectorAll<HTMLElement>(
          '[data-testid="activity-heatmap-legend-swatch-skeleton"]',
        );

        expect(container.querySelector('[role="progressbar"]')).toBeNull();
        expect(container.querySelector(".MuiLinearProgress-root")).toBeNull();
        expect(section?.getAttribute("aria-busy")).toBe("true");
        expect(skeleton?.getAttribute("role")).toBe("status");
        expect(skeleton?.getAttribute("aria-label")).toBe(
          "Loading daily activity",
        );

        expect(weekdayRail).not.toBeNull();
        expect(viewport).not.toBeNull();
        expect(skeletonGrid).not.toBeNull();
        expect(legendSkeleton).not.toBeNull();
        expect(
          container.querySelector('[aria-label="Activity level legend"]'),
        ).toBeNull();
        expect(
          container.querySelectorAll('[data-testid="activity-day"]'),
        ).toHaveLength(0);

        expect(skeletonCells).toHaveLength(ACTIVITY_HEATMAP_WEEKS * 7);
        expect(legendSwatches).toHaveLength(3);

        // Seven weekday rows and shared geometry constants.
        const railStyle = window.getComputedStyle(weekdayRail!);
        const viewportStyle = window.getComputedStyle(viewport!);
        const gridStyle = window.getComputedStyle(skeletonGrid!);
        expect(railStyle.gridTemplateRows).toBe(
          `repeat(7, ${activityHeatmapGeometry.cellSize}px)`,
        );
        expect(railStyle.rowGap).toBe(`${activityHeatmapGeometry.cellGap}px`);
        expect(parseFloat(railStyle.paddingTop)).toBe(
          activityHeatmapGeometry.cellHoverReach,
        );
        expect(viewportStyle.overflowX).toBe("auto");
        expect(viewportStyle.overflowY).toBe("clip");
        expect(parseFloat(viewportStyle.paddingTop)).toBe(
          activityHeatmapGeometry.cellHoverReach,
        );
        expect(parseFloat(viewportStyle.paddingBottom)).toBe(
          activityHeatmapGeometry.cellHoverReach,
        );
        expect(viewport!.scrollLeft).toBe(490);
        // Decorative skeleton viewport stays non-focusable inside aria-hidden.
        expect(viewport!.getAttribute("tabindex")).toBeNull();

        expect(gridStyle.gridTemplateColumns).toBe(
          `repeat(${ACTIVITY_HEATMAP_WEEKS}, ${activityHeatmapGeometry.cellSize}px)`,
        );
        expect(gridStyle.gridTemplateRows).toBe(
          `repeat(7, ${activityHeatmapGeometry.cellSize}px)`,
        );
        expect(gridStyle.columnGap).toBe(
          `${activityHeatmapGeometry.cellGap}px`,
        );
        expect(gridStyle.rowGap).toBe(`${activityHeatmapGeometry.cellGap}px`);

        const firstCellStyle = window.getComputedStyle(skeletonCells[0]!);
        expect(firstCellStyle.width).toBe(
          `${activityHeatmapGeometry.cellSize}px`,
        );
        expect(firstCellStyle.height).toBe(
          `${activityHeatmapGeometry.cellSize}px`,
        );
        expect(parseFloat(firstCellStyle.borderRadius)).toBeGreaterThan(0);

        const firstSwatchStyle = window.getComputedStyle(legendSwatches[0]!);
        expect(firstSwatchStyle.width).toBe(
          `${activityHeatmapGeometry.cellSize}px`,
        );
        expect(firstSwatchStyle.height).toBe(
          `${activityHeatmapGeometry.cellSize}px`,
        );

        for (const box of viewport!.querySelectorAll("*")) {
          expect(window.getComputedStyle(box).overflowY).toBe("visible");
        }
      } finally {
        scrollWidth.mockRestore();
        clientWidth.mockRestore();
      }
    },
  );

  it("uses theme-aware neutral skeleton fills in light and dark modes without leaking activity colors", () => {
    const hexToRgb = (hex: string) => {
      const value = Number.parseInt(hex.slice(1), 16);
      const red = (value >> 16) & 255;
      const green = (value >> 8) & 255;
      const blue = value & 255;
      return `rgb(${red}, ${green}, ${blue})`;
    };

    const expectedLightRgb = hexToRgb(activityHeatmapSkeleton.light);
    const expectedDarkRgb = hexToRgb(activityHeatmapSkeleton.dark);

    renderHeatmap(0, "loading", false);
    const lightCells = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="activity-heatmap-skeleton-cell"]',
      ),
    );
    const lightPastCell = lightCells.find(
      (cell) => cell.dataset.future !== "true",
    );
    const lightFutureCell = lightCells.find(
      (cell) => cell.dataset.future === "true",
    );
    const lightSwatch = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-legend-swatch-skeleton"]',
    );
    const lightLabelBar = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-legend-label-skeleton-bar"]',
    );

    expect(window.getComputedStyle(lightPastCell!).backgroundColor).toBe(
      expectedLightRgb,
    );
    expect(window.getComputedStyle(lightSwatch!).backgroundColor).toBe(
      expectedLightRgb,
    );
    expect(window.getComputedStyle(lightLabelBar!).backgroundColor).toBe(
      expectedLightRgb,
    );
    expect(window.getComputedStyle(lightFutureCell!).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );

    renderHeatmap(0, "loading", true);
    const darkCells = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="activity-heatmap-skeleton-cell"]',
      ),
    );
    const darkPastCell = darkCells.find(
      (cell) => cell.dataset.future !== "true",
    );
    const darkSwatch = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-legend-swatch-skeleton"]',
    );
    const darkLabelBar = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-legend-label-skeleton-bar"]',
    );

    expect(window.getComputedStyle(darkPastCell!).backgroundColor).toBe(
      expectedDarkRgb,
    );
    expect(window.getComputedStyle(darkSwatch!).backgroundColor).toBe(
      expectedDarkRgb,
    );
    expect(window.getComputedStyle(darkLabelBar!).backgroundColor).toBe(
      expectedDarkRgb,
    );
    expect(expectedDarkRgb).not.toBe(expectedLightRgb);
  });

  it("sizes skeleton legend label bars from the active locale without showing text", () => {
    renderHeatmap(0, "loading", false, "de", de);

    const skeletonSlots = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="activity-heatmap-legend-label-skeleton"]',
      ),
    );
    expect(skeletonSlots).toHaveLength(2);
    expect(skeletonSlots.map((slot) => slot.textContent)).toEqual([
      "Weniger",
      "Mehr",
    ]);

    for (const slot of skeletonSlots) {
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      const hiddenLabel = slot.querySelector<HTMLElement>("span");
      expect(hiddenLabel).not.toBeNull();
      const hiddenStyle = window.getComputedStyle(hiddenLabel!);
      expect(hiddenStyle.visibility).toBe("hidden");
      expect(hiddenStyle.fontSize).toBe("9px");
      expect(hiddenStyle.lineHeight).toBe("1");
    }
  });

  it("disables skeleton pulse animation when reduced motion is preferred", () => {
    renderHeatmap(0, "loading");
    const animatedGrid = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-skeleton-grid"]',
    );
    const animatedLegend = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-legend-skeleton"]',
    );
    const animatedGridCss = window.getComputedStyle(animatedGrid!).animation;
    const animatedLegendCss = window.getComputedStyle(
      animatedLegend!,
    ).animation;
    expect(animatedGridCss).toContain(`${skeletonPulse.duration}s`);
    expect(animatedGridCss).toContain("infinite");
    expect(animatedLegendCss).toContain(`${skeletonPulse.duration}s`);
    expect(animatedLegendCss).toContain("infinite");

    const gridClass = Array.from(animatedGrid!.classList).find((name) =>
      name.startsWith("css-"),
    );
    const emotionCss = Array.from(
      document.querySelectorAll("style[data-emotion]"),
      (style) => style.textContent ?? "",
    )
      .join("\n")
      .replace(/\s+/g, "");
    expect(emotionCss).toContain(
      `@media(prefers-reduced-motion:reduce){.${gridClass}{`,
    );
    expect(emotionCss).toContain("animation:none");

    setMatchMedia((query) => query === reducedMotionQuery);
    renderHeatmap(0, "loading");

    const staticGrid = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-skeleton-grid"]',
    );
    const staticLegend = container.querySelector<HTMLElement>(
      '[data-testid="activity-heatmap-legend-skeleton"]',
    );
    expect(window.getComputedStyle(staticGrid!).animation).toBe("none");
    expect(window.getComputedStyle(staticLegend!).animation).toBe("none");
  });

  it("preserves identical layout geometry when transitioning from loading to success", () => {
    const readLayoutMetrics = () => {
      const layout = container.querySelector<HTMLElement>(
        '[data-testid="activity-heatmap-layout"]',
      );
      const rail = container.querySelector<HTMLElement>(
        '[data-testid="activity-heatmap-labels"]',
      );
      const viewport = container.querySelector<HTMLElement>(
        '[data-testid="activity-heatmap-viewport"]',
      );
      const gridWrapper = viewport?.firstElementChild as HTMLElement | null;
      const grid = gridWrapper?.firstElementChild as HTMLElement | null;
      const legend =
        container.querySelector<HTMLElement>(
          '[data-testid="activity-heatmap-legend-skeleton"]',
        ) ??
        container.querySelector<HTMLElement>(
          '[aria-label="Activity level legend"]',
        );

      return {
        layoutColumnGap: window.getComputedStyle(layout!).columnGap,
        railFlex: window.getComputedStyle(rail!).flex,
        railRows: window.getComputedStyle(rail!).gridTemplateRows,
        railRowGap: window.getComputedStyle(rail!).rowGap,
        railPaddingTop: window.getComputedStyle(rail!).paddingTop,
        viewportPadding: window.getComputedStyle(viewport!).padding,
        viewportOverflowX: window.getComputedStyle(viewport!).overflowX,
        viewportOverflowY: window.getComputedStyle(viewport!).overflowY,
        gridMinWidth: window.getComputedStyle(gridWrapper!).minWidth,
        gridColumns: window.getComputedStyle(grid!).gridTemplateColumns,
        gridRows: window.getComputedStyle(grid!).gridTemplateRows,
        gridColumnGap: window.getComputedStyle(grid!).columnGap,
        gridRowGap: window.getComputedStyle(grid!).rowGap,
        legendMarginTop: window.getComputedStyle(legend!).marginTop,
      };
    };

    renderHeatmap(0, "loading");
    const loadingMetrics = readLayoutMetrics();
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).not.toBeNull();

    renderHeatmap(120, "success");
    const readyMetrics = readLayoutMetrics();
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="home-activity-heatmap"]')
        ?.getAttribute("aria-busy"),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="activity-day"]'),
    ).toHaveLength(ACTIVITY_HEATMAP_WEEKS * 7);
    expect(
      container.querySelector('[aria-label="Activity level legend"]'),
    ).not.toBeNull();

    expect(readyMetrics).toEqual(loadingMetrics);
  });

  it("renders the real empty heatmap for zero activity and keeps the error message on failure", () => {
    renderHeatmap(0, "success");
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="activity-day"]'),
    ).toHaveLength(ACTIVITY_HEATMAP_WEEKS * 7);
    expect(container.textContent).toContain(
      "Your dictation activity will appear here.",
    );

    renderHeatmap(0, "error");
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      "Daily activity could not be loaded.",
    );
  });

  it("avoids flashing a skeleton during refreshes when activity data is already available", () => {
    // Direct loading render with cached activity keeps the heatmap visible.
    renderHeatmap(42, "loading");
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="activity-day"]'),
    ).toHaveLength(ACTIVITY_HEATMAP_WEEKS * 7);

    // Refreshing after a settled zero-activity load also stays on the empty heatmap.
    renderHeatmap(0, "success");
    renderHeatmap(0, "loading");
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).toBeNull();
    expect(container.textContent).toContain(
      "Your dictation activity will appear here.",
    );

    // Recovering from an error still displays the skeleton while retrying.
    renderHeatmap(0, "error");
    expect(container.textContent).toContain(
      "Daily activity could not be loaded.",
    );
    renderHeatmap(0, "loading");
    expect(
      container.querySelector('[data-testid="activity-heatmap-skeleton"]'),
    ).not.toBeNull();
  });
});
