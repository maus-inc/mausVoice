import { ACTIVITY_HEATMAP_WEEKS } from "../utils/activity-grid.utils";

const cellSize = 10;
const cellGap = 4;
const labelColumnWidth = 22;

/** Pixel geometry for the compact, horizontally scrolling year view. */
export const activityHeatmapGeometry = {
  cellSize,
  cellGap,
  labelColumnWidth,
  viewportWidth: 274,
  minWidth:
    labelColumnWidth +
    ACTIVITY_HEATMAP_WEEKS * cellSize +
    (ACTIVITY_HEATMAP_WEEKS - 1) * cellGap,
} as const;
