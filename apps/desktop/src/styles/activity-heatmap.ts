import { ACTIVITY_HEATMAP_WEEKS } from "../utils/activity-grid.utils";

const cellSize = 10;
const cellGap = 4;
const labelColumnWidth = 22;
const desktopLabelColumnWidth = 13;
const dayGridWidth =
  ACTIVITY_HEATMAP_WEEKS * cellSize + (ACTIVITY_HEATMAP_WEEKS - 1) * cellGap;

/** How far a hovered cell grows past its resting box. */
const cellHoverScale = 1.35;
/** The ring a hovered cell draws outside its box, as width plus offset. */
const cellHoverOutlineInset = 2;

/**
 * Room one edge needs to show a hovered cell whole. Half the growth covers the
 * scaled box, and the ring sits outside that.
 */
const cellHoverReach = Math.ceil(
  (cellSize * (cellHoverScale - 1)) / 2 + cellHoverOutlineInset,
);

/** Pixel geometry for the compact, horizontally scrolling year view. */
export const activityHeatmapGeometry = {
  cellSize,
  cellGap,
  labelColumnWidth,
  desktopLabelColumnWidth,
  dayGridWidth,
  cellHoverScale,
  /**
   * Room reserved on every edge of the scrolling viewport so a hovered cell
   * near an edge keeps its expanded box and ring.
   *
   * A viewport that scrolls on one axis clips the other as well. The CSS
   * overflow rules compute a `visible` axis to `auto` as soon as the other
   * axis scrolls, so the top and bottom rows would otherwise be shaved by the
   * same box that scrolls the weeks.
   */
  cellHoverReach,
  /**
   * Preserve the reference plot alignment without shifting the scroll target
   * into the metric-card gutter after splitting the fixed weekday rail.
   */
  desktopRightInset: labelColumnWidth - desktopLabelColumnWidth,
  /** Keeps the chart centered beside the metrics in the desktop layout. */
  desktopTopPadding: 30,
  viewportWidth: 274,
} as const;
