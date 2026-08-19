import { afterEach, describe, expect, it } from "vitest";
import {
  COLLAPSING_ATTR,
  attachScrollListCollapse,
  collapseProgress,
  collapseSpacerExpr,
  collapseSpacerPx,
  headerHeightExpr,
  headerHeightPx,
  measureHeaderMetrics,
  sameHeaderMetrics,
  titleHeightExpr,
  titleScaleRange,
  type CollapseMediaQuery,
  type CollapseScroller,
  type HeaderMetrics,
} from "./scrollListCollapse";

const SAMPLE_RECTS = {
  expandedHeader: 140,
  collapsedHeader: 60,
  expandedTitle: 40,
  collapsedTitle: 28,
};

const sampleMetrics = () => measureHeaderMetrics(SAMPLE_RECTS);

describe("collapseProgress", () => {
  it("is 1 when there is no distance to collapse", () => {
    expect(collapseProgress(0, 0)).toBe(1);
    expect(collapseProgress(40, 0)).toBe(1);
    expect(collapseProgress(40, -10)).toBe(1);
  });

  it("is monotonic and clamped to [0, 1]", () => {
    expect(collapseProgress(-8, 80)).toBe(0);
    expect(collapseProgress(0, 80)).toBe(0);
    expect(collapseProgress(20, 80)).toBe(0.25);
    expect(collapseProgress(40, 80)).toBe(0.5);
    expect(collapseProgress(80, 80)).toBe(1);
    expect(collapseProgress(240, 80)).toBe(1);
  });

  it("snaps for prefers-reduced-motion", () => {
    expect(collapseProgress(0, 80, true)).toBe(0);
    expect(collapseProgress(1, 80, true)).toBe(1);
    expect(collapseProgress(40, 80, true)).toBe(1);
  });
});

describe("header geometry", () => {
  it("derives collapse distance and an up-scale from expanded/collapsed rects", () => {
    const metrics = sampleMetrics();
    expect(metrics.collapsedHeight).toBe(60);
    expect(metrics.collapseDistance).toBe(80);
    expect(metrics.collapsedTitleHeight).toBe(28);
    expect(metrics.titleHeightDelta).toBe(12);
    expect(metrics.titleScale).toBeCloseTo(40 / 28);
    expect(titleScaleRange(metrics.titleScale)).toBeCloseTo(40 / 28 - 1);
  });

  it("clamps inverted or degenerate title scales", () => {
    expect(
      measureHeaderMetrics({
        ...SAMPLE_RECTS,
        collapsedTitle: 0,
      }).titleScale,
    ).toBe(1);
    expect(titleScaleRange(0.5)).toBe(0);
    expect(titleScaleRange(Number.NaN)).toBe(0);
    expect(titleScaleRange(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("keeps header + spacer equal to the expanded height at every progress", () => {
    const metrics = sampleMetrics();
    const expanded = metrics.collapsedHeight + metrics.collapseDistance;
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      expect(
        headerHeightPx(metrics, progress) + collapseSpacerPx(metrics, progress),
      ).toBeCloseTo(expanded);
    }
  });

  it("emits CSS that is driven only by --p", () => {
    const metrics = sampleMetrics();
    expect(headerHeightExpr(metrics)).toBe(
      "calc(60px + 80px * (1 - var(--p, 0)))",
    );
    expect(titleHeightExpr(metrics)).toBe(
      "calc(28px + 12px * (1 - var(--p, 0)))",
    );
    expect(collapseSpacerExpr(metrics.collapseDistance)).toBe(
      "calc(80px * var(--p, 0))",
    );
    expect(
      headerHeightExpr({ ...metrics, collapsedHeight: 0, collapseDistance: 0 }),
    ).toBeUndefined();
    expect(collapseSpacerExpr(0)).toBeUndefined();
  });

  it("treats identical metrics as unchanged so React can bail out", () => {
    const metrics = sampleMetrics();
    expect(sameHeaderMetrics(metrics, { ...metrics })).toBe(true);
    expect(
      sameHeaderMetrics(metrics, { ...metrics, collapseDistance: 81 }),
    ).toBe(false);
  });
});

type MockScroller = CollapseScroller & {
  emitScroll: () => void;
  getProperty: (name: string) => string | undefined;
  listenerCount: () => number;
  isCollapsing: () => boolean;
};

const createScroller = (scrollTop = 0): MockScroller => {
  const listeners = new Set<() => void>();
  const props = new Map<string, string>();
  const attrs = new Set<string>();

  return {
    scrollTop,
    style: {
      setProperty: (name, value) => {
        props.set(name, value);
      },
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    toggleAttribute: (name, force) => {
      const on = force ?? !attrs.has(name);
      if (on) {
        attrs.add(name);
      } else {
        attrs.delete(name);
      }
      return on;
    },
    emitScroll: () => {
      for (const listener of listeners) {
        listener();
      }
    },
    getProperty: (name) => props.get(name),
    listenerCount: () => listeners.size,
    isCollapsing: () => attrs.has(COLLAPSING_ATTR),
  };
};

class MockResizeObserver {
  static constructed = 0;
  static live = 0;
  static instances: MockResizeObserver[] = [];

  observed = new Set<Element>();
  disconnected = false;
  readonly callback: () => void;

  constructor(callback: () => void) {
    this.callback = callback;
    MockResizeObserver.constructed += 1;
    MockResizeObserver.live += 1;
    MockResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  disconnect() {
    if (!this.disconnected) {
      this.disconnected = true;
      this.observed.clear();
      MockResizeObserver.live -= 1;
    }
  }

  trigger() {
    this.callback();
  }
}

const resetObservers = () => {
  MockResizeObserver.constructed = 0;
  MockResizeObserver.live = 0;
  MockResizeObserver.instances = [];
};

const createMediaQuery = (matches = false) => {
  const listeners = new Set<() => void>();
  const mediaQuery: CollapseMediaQuery & {
    setMatches: (next: boolean) => void;
    listenerCount: () => number;
  } = {
    matches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    setMatches: (next) => {
      mediaQuery.matches = next;
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
  return mediaQuery;
};

const syncFrame = (callback: FrameRequestCallback) => {
  callback(0);
  return 1;
};

const attach = ({
  scroller,
  metrics = sampleMetrics(),
  measureElements = [{}, {}] as unknown as Element[],
  mediaQuery = null,
  prefersReducedMotion,
  onMetrics = () => undefined,
}: {
  scroller: CollapseScroller;
  metrics?: HeaderMetrics;
  measureElements?: Element[];
  mediaQuery?: CollapseMediaQuery | null;
  prefersReducedMotion?: () => boolean;
  onMetrics?: (metrics: HeaderMetrics) => void;
}) =>
  attachScrollListCollapse({
    scroller,
    measureElements,
    readMetrics: () => metrics,
    onMetrics,
    mediaQuery,
    prefersReducedMotion,
    resizeObserver: MockResizeObserver,
    requestFrame: syncFrame,
    cancelFrame: () => undefined,
  });

afterEach(() => {
  resetObservers();
});

describe("attachScrollListCollapse", () => {
  it("writes a clamped --p from scrollTop and marks mid-transition as collapsing", () => {
    const scroller = createScroller(40);
    const cleanup = attach({ scroller });

    expect(scroller.getProperty("--p")).toBe("0.5");
    expect(scroller.isCollapsing()).toBe(true);

    scroller.scrollTop = 400;
    scroller.emitScroll();
    expect(scroller.getProperty("--p")).toBe("1");
    expect(scroller.isCollapsing()).toBe(false);

    scroller.scrollTop = 0;
    scroller.emitScroll();
    expect(scroller.getProperty("--p")).toBe("0");
    expect(scroller.isCollapsing()).toBe(false);

    cleanup();
  });

  it("observes only the measure clones and detaches listeners on cleanup", () => {
    const scroller = createScroller(0);
    const measureElements = [{ id: "a" }, { id: "b" }] as unknown as Element[];
    const mediaQuery = createMediaQuery();
    const cleanup = attach({ scroller, measureElements, mediaQuery });

    expect(MockResizeObserver.instances).toHaveLength(1);
    expect([...MockResizeObserver.instances[0]!.observed]).toEqual(
      measureElements,
    );
    expect(scroller.listenerCount()).toBe(1);
    expect(mediaQuery.listenerCount()).toBe(1);

    cleanup();

    expect(MockResizeObserver.instances[0]!.disconnected).toBe(true);
    expect(MockResizeObserver.live).toBe(0);
    expect(scroller.listenerCount()).toBe(0);
    expect(mediaQuery.listenerCount()).toBe(0);
  });

  it("does not grow observers or listeners across remount and item-refresh cycles", () => {
    const scroller = createScroller(40);
    const measureElements = [{}, {}, {}, {}] as unknown as Element[];
    let latest: HeaderMetrics | null = null;

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const cleanup = attach({
        scroller,
        measureElements,
        onMetrics: (metrics) => {
          latest = metrics;
        },
      });
      scroller.emitScroll();
      cleanup();
    }

    expect(latest).toEqual(sampleMetrics());
    expect(scroller.getProperty("--p")).toBe("0.5");
    expect(scroller.listenerCount()).toBe(0);
    expect(MockResizeObserver.constructed).toBe(20);
    expect(MockResizeObserver.live).toBe(0);
  });

  it("keeps --p in [0, 1] when metrics are re-read mid-scroll", () => {
    const scroller = createScroller(40);
    let metrics = sampleMetrics();
    const recorded: string[] = [];
    const onMetrics = (next: HeaderMetrics) => {
      metrics = next;
    };

    const first = attachScrollListCollapse({
      scroller,
      measureElements: [],
      readMetrics: () => metrics,
      onMetrics,
      mediaQuery: null,
      resizeObserver: MockResizeObserver,
      requestFrame: syncFrame,
      cancelFrame: () => undefined,
    });
    recorded.push(scroller.getProperty("--p") ?? "");

    // Item-list mutation: same collapse geometry, new attach (what a careless
    // items.length effect would do). Progress must not reset or escape [0, 1].
    first();
    const second = attachScrollListCollapse({
      scroller,
      measureElements: [],
      readMetrics: () => metrics,
      onMetrics,
      mediaQuery: null,
      resizeObserver: MockResizeObserver,
      requestFrame: syncFrame,
      cancelFrame: () => undefined,
    });
    recorded.push(scroller.getProperty("--p") ?? "");
    scroller.scrollTop = 40;
    scroller.emitScroll();
    recorded.push(scroller.getProperty("--p") ?? "");
    second();

    expect(recorded.every((value) => value === "0.5")).toBe(true);
    const heightBefore = headerHeightPx(metrics, 0.5);
    const heightAfter = headerHeightPx(
      metrics,
      Number(scroller.getProperty("--p")),
    );
    expect(heightAfter).toBe(heightBefore);
  });

  it("snaps --p when the reduced-motion query flips", () => {
    const scroller = createScroller(40);
    const mediaQuery = createMediaQuery(false);
    const cleanup = attach({ scroller, mediaQuery });

    expect(scroller.getProperty("--p")).toBe("0.5");
    mediaQuery.setMatches(true);
    expect(scroller.getProperty("--p")).toBe("1");
    mediaQuery.setMatches(false);
    expect(scroller.getProperty("--p")).toBe("0.5");
    cleanup();
  });
});
