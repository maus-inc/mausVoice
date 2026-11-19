import { reducedMotionQuery } from "../../styles/motion";

export type HeaderMetrics = {
  collapsedHeight: number;
  collapseDistance: number;
  collapsedTitleHeight: number;
  titleHeightDelta: number;
  titleScale: number;
};

export const INITIAL_HEADER_METRICS: HeaderMetrics = {
  collapsedHeight: 0,
  collapseDistance: 0,
  collapsedTitleHeight: 0,
  titleHeightDelta: 0,
  titleScale: 1,
};

export const COLLAPSING_ATTR = "data-collapsing";
export const COLLAPSE_ANIM_ATTR = "data-scroll-list-collapse-anim";

export type CollapseScroller = {
  scrollTop: number;
  style: { setProperty: (property: string, value: string) => void };
  addEventListener: (
    type: "scroll",
    listener: () => void,
    options?: { passive?: boolean },
  ) => void;
  removeEventListener: (type: "scroll", listener: () => void) => void;
  setAttribute: (qualifiedName: string, value: string) => void;
  removeAttribute: (qualifiedName: string) => void;
};

export type CollapseMediaQuery = {
  matches: boolean;
  addEventListener: (type: "change", listener: () => void) => void;
  removeEventListener: (type: "change", listener: () => void) => void;
};

type ResizeObserverLike = {
  observe: (target: Element) => void;
  disconnect: () => void;
};

type ResizeObserverCtor = new (callback: () => void) => ResizeObserverLike;

export type AttachScrollListCollapseOptions = {
  scroller: CollapseScroller;
  measureElements: readonly (Element | null | undefined)[];
  readMetrics: () => HeaderMetrics;
  onMetrics: (metrics: HeaderMetrics) => void;
  prefersReducedMotion?: () => boolean;
  mediaQuery?: CollapseMediaQuery | null;
  /** Pass `null` to skip ResizeObserver (tests / no-RO fallback). */
  resizeObserver?: ResizeObserverCtor | null;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};

export type ScrollListCollapseHandle = {
  disconnect: () => void;
  refresh: () => void;
  /** Increments on every measure so callers can skip a redundant refresh. */
  readonly generation: number;
};

/**
 * Maps scroll position to collapse progress in [0, 1].
 * Reduced-motion users snap: expanded only while parked at the top.
 */
export function collapseProgress(
  scrollTop: number,
  collapseDistance: number,
  reducedMotion = false,
): number {
  if (collapseDistance <= 0) {
    return 1;
  }
  if (reducedMotion) {
    return scrollTop > 0 ? 1 : 0;
  }
  if (scrollTop <= 0) {
    return 0;
  }
  return Math.min(scrollTop / collapseDistance, 1);
}

export function measureHeaderMetrics(rects: {
  expandedHeader: number;
  collapsedHeader: number;
  expandedTitle: number;
  collapsedTitle: number;
}): HeaderMetrics {
  const collapsedHeight = Math.max(rects.collapsedHeader, 0);
  const collapseDistance = Math.max(
    rects.expandedHeader - rects.collapsedHeader,
    0,
  );
  const collapsedTitleHeight = Math.max(rects.collapsedTitle, 0);
  const titleHeightDelta = Math.max(
    rects.expandedTitle - rects.collapsedTitle,
    0,
  );
  // Visible title is the collapsed (h5) size and scales UP to the expanded
  // (h4) size, so the ratio is expanded/collapsed — not the inverse.
  const rawScale =
    collapsedTitleHeight > 0 ? rects.expandedTitle / collapsedTitleHeight : 1;
  const titleScale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;

  return {
    collapsedHeight,
    collapseDistance,
    collapsedTitleHeight,
    titleHeightDelta,
    titleScale,
  };
}

export function titleScaleRange(titleScale: number): number {
  if (!Number.isFinite(titleScale)) {
    return 0;
  }
  return Math.max(titleScale - 1, 0);
}

export function headerHeightPx(
  metrics: HeaderMetrics,
  progress: number,
): number {
  return metrics.collapsedHeight + metrics.collapseDistance * (1 - progress);
}

export function collapseSpacerPx(
  metrics: HeaderMetrics,
  progress: number,
): number {
  return metrics.collapseDistance * progress;
}

export function sameHeaderMetrics(
  left: HeaderMetrics,
  right: HeaderMetrics,
): boolean {
  return (
    left.collapsedHeight === right.collapsedHeight &&
    left.collapseDistance === right.collapseDistance &&
    left.collapsedTitleHeight === right.collapsedTitleHeight &&
    left.titleHeightDelta === right.titleHeightDelta &&
    left.titleScale === right.titleScale
  );
}

export function headerHeightExpr(metrics: HeaderMetrics): string | undefined {
  if (metrics.collapseDistance <= 0 && metrics.collapsedHeight <= 0) {
    return undefined;
  }
  return `calc(${metrics.collapsedHeight}px + ${metrics.collapseDistance}px * (1 - var(--p, 0)))`;
}

export function titleHeightExpr(metrics: HeaderMetrics): string | undefined {
  if (metrics.titleHeightDelta <= 0 && metrics.collapsedTitleHeight <= 0) {
    return undefined;
  }
  return `calc(${metrics.collapsedTitleHeight}px + ${metrics.titleHeightDelta}px * (1 - var(--p, 0)))`;
}

export function collapseSpacerExpr(
  collapseDistance: number,
): string | undefined {
  if (collapseDistance <= 0) {
    return undefined;
  }
  return `calc(${collapseDistance}px * var(--p, 0))`;
}

function resolveMediaQuery(
  provided: CollapseMediaQuery | null | undefined,
): CollapseMediaQuery | null {
  if (provided !== undefined) {
    return provided;
  }
  if (typeof globalThis.matchMedia !== "function") {
    return null;
  }
  return globalThis.matchMedia(reducedMotionQuery);
}

function resolveResizeObserver(
  provided: ResizeObserverCtor | null | undefined,
): ResizeObserverCtor | undefined {
  if (provided === null) {
    return undefined;
  }
  if (provided) {
    return provided;
  }
  if (globalThis.ResizeObserver === undefined) {
    return undefined;
  }
  return globalThis.ResizeObserver;
}

/**
 * Single owner of `--p`. Measures geometry only from hidden clones (passed as
 * `measureElements`) and never observes the scroller, so header-height changes
 * cannot re-enter the measure path.
 */
export function attachScrollListCollapse({
  scroller,
  measureElements,
  readMetrics,
  onMetrics,
  prefersReducedMotion: prefersReducedMotionOption,
  mediaQuery: mediaQueryOption,
  resizeObserver,
  requestFrame = globalThis.requestAnimationFrame.bind(globalThis),
  cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis),
}: AttachScrollListCollapseOptions): ScrollListCollapseHandle {
  const mediaQuery = resolveMediaQuery(mediaQueryOption);
  const prefersReducedMotion =
    prefersReducedMotionOption ?? (() => mediaQuery?.matches ?? false);

  let collapseDistance = 0;
  let lastProgress: number | null = null;
  let lastCollapsing: boolean | null = null;
  let scrollFrame = 0;
  let measureFrame = 0;
  let hasScrollFrame = false;
  let hasMeasureFrame = false;
  let generation = 0;

  const writeProgress = () => {
    const progress = collapseProgress(
      scroller.scrollTop,
      collapseDistance,
      prefersReducedMotion(),
    );
    const collapsing = progress > 0 && progress < 1;
    if (lastProgress !== progress) {
      lastProgress = progress;
      scroller.style.setProperty("--p", `${progress}`);
    }
    if (lastCollapsing !== collapsing) {
      lastCollapsing = collapsing;
      if (collapsing) {
        scroller.setAttribute(COLLAPSING_ATTR, "true");
      } else {
        scroller.removeAttribute(COLLAPSING_ATTR);
      }
    }
  };

  const measure = () => {
    generation += 1;
    const metrics = readMetrics();
    collapseDistance = metrics.collapseDistance;
    onMetrics(metrics);
    writeProgress();
  };

  const scheduleMeasure = () => {
    if (hasMeasureFrame) {
      return;
    }
    hasMeasureFrame = true;
    measureFrame = requestFrame(() => {
      hasMeasureFrame = false;
      measure();
    });
  };

  const handleScroll = () => {
    if (hasScrollFrame) {
      return;
    }
    hasScrollFrame = true;
    scrollFrame = requestFrame(() => {
      hasScrollFrame = false;
      writeProgress();
    });
  };

  const handleMotionChange = () => {
    lastProgress = null;
    writeProgress();
  };

  measure();

  scroller.addEventListener("scroll", handleScroll, { passive: true });
  mediaQuery?.addEventListener("change", handleMotionChange);

  const ResizeObserverImpl = resolveResizeObserver(resizeObserver);

  let observer: ResizeObserverLike | null = null;
  const removeWindowResize = (() => {
    if (ResizeObserverImpl) {
      observer = new ResizeObserverImpl(scheduleMeasure);
      for (const element of measureElements) {
        if (element) {
          observer.observe(element);
        }
      }
      return undefined;
    }
    if (typeof globalThis.addEventListener !== "function") {
      return undefined;
    }
    const onResize = () => scheduleMeasure();
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  })();

  return {
    refresh: measure,
    get generation() {
      return generation;
    },
    disconnect: () => {
      scroller.removeEventListener("scroll", handleScroll);
      mediaQuery?.removeEventListener("change", handleMotionChange);
      observer?.disconnect();
      removeWindowResize?.();
      if (hasScrollFrame) {
        cancelFrame(scrollFrame);
      }
      if (hasMeasureFrame) {
        cancelFrame(measureFrame);
      }
    },
  };
}
