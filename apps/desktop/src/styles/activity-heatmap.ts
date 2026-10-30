import { ACTIVITY_HEATMAP_WEEKS } from "../utils/activity-grid.utils";

const cellSize = 10;
const cellGap = 4;
const labelColumnWidth = 22;
const desktopLabelColumnWidth = 13;
const dayGridWidth =
  ACTIVITY_HEATMAP_WEEKS * cellSize + (ACTIVITY_HEATMAP_WEEKS - 1) * cellGap;

/** Pixel geometry for the compact, horizontally scrolling year view. */
export const activityHeatmapGeometry = {
  cellSize,
  cellGap,
  labelColumnWidth,
  desktopLabelColumnWidth,
  dayGridWidth,
  /**
   * Preserve the reference plot alignment without shifting the scroll target
   * into the metric-card gutter after splitting the fixed weekday rail.
   */
  desktopRightInset: labelColumnWidth - desktopLabelColumnWidth,
  /** Keeps the chart centered beside the metrics in the desktop layout. */
  desktopTopPadding: 30,
  viewportWidth: 274,
} as const;
