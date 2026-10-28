import type { DailyWordActivity } from "../types/home.types";
import { dateFromLocalDateKey, toLocalDateKey } from "./date.utils";

export const ACTIVITY_HEATMAP_WEEKS = 53;

const LOW_ACTIVITY_WORDS = 100;
const MODERATE_ACTIVITY_WORDS = 500;
const HIGH_ACTIVITY_WORDS = 1_500;

export type ActivityGridCell = {
  localDate: string;
  wordCount: number;
  intensity: 0 | 1 | 2 | 3 | 4;
  isToday: boolean;
  isFuture: boolean;
};

export type ActivityGrid = {
  weeks: ActivityGridCell[][];
  startDate: string;
  endDate: string;
};

const atLocalNoon = (date: Date): Date => {
  const noon = new Date(date);
  noon.setHours(12, 0, 0, 0);
  return noon;
};

const startOfCurrentWeek = (date: Date): Date => {
  const start = atLocalNoon(date);
  start.setDate(start.getDate() - start.getDay());
  return start;
};

export const getActivityDateRange = (
  today: Date = new Date(),
  weekCount = ACTIVITY_HEATMAP_WEEKS,
): { startDate: string; endDate: string } => {
  if (!Number.isInteger(weekCount) || weekCount < 1) {
    throw new RangeError("Activity heatmap needs at least one week");
  }
  const endDate = atLocalNoon(today);
  const startDate = startOfCurrentWeek(today);
  startDate.setDate(startDate.getDate() - (weekCount - 1) * 7);
  return {
    startDate: toLocalDateKey(startDate),
    endDate: toLocalDateKey(endDate),
  };
};

export const activityIntensity = (
  wordCount: number,
): ActivityGridCell["intensity"] => {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return 0;
  if (wordCount < LOW_ACTIVITY_WORDS) return 1;
  if (wordCount < MODERATE_ACTIVITY_WORDS) return 2;
  if (wordCount < HIGH_ACTIVITY_WORDS) return 3;
  return 4;
};

/**
 * Lay out a full year of local calendar days as Sunday-first week columns.
 * Noon-based dates and calendar-day arithmetic keep the grid stable across
 * daylight-saving transitions, which can make midnight timestamps ambiguous.
 */
export const buildActivityGrid = (
  activity: DailyWordActivity[],
  today: Date = new Date(),
  weekCount = ACTIVITY_HEATMAP_WEEKS,
): ActivityGrid => {
  const range = getActivityDateRange(today, weekCount);
  const todayKey = toLocalDateKey(atLocalNoon(today));
  const totals = new Map<string, number>();
  for (const item of activity) {
    if (item.wordCount <= 0 || !Number.isFinite(item.wordCount)) continue;
    totals.set(
      item.localDate,
      (totals.get(item.localDate) ?? 0) + item.wordCount,
    );
  }

  const firstDay = dateFromLocalDateKey(range.startDate);
  const weeks: ActivityGridCell[][] = [];

  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
    const week: ActivityGridCell[] = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = atLocalNoon(firstDay);
      date.setDate(firstDay.getDate() + weekIndex * 7 + dayIndex);
      const localDate = toLocalDateKey(date);
      const wordCount = totals.get(localDate) ?? 0;
      week.push({
        localDate,
        wordCount,
        intensity: activityIntensity(wordCount),
        isToday: localDate === todayKey,
        isFuture: localDate > todayKey,
      });
    }
    weeks.push(week);
  }

  return { weeks, startDate: range.startDate, endDate: range.endDate };
};
