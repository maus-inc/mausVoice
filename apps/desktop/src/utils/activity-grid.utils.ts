import type { DailyWordActivity } from "../repos/daily-activity.repo";
import { dateFromLocalKey, localDateKey } from "./date.utils";

export const ACTIVITY_WEEKS = 26;
export const ACTIVITY_DAYS_PER_WEEK = 7;

export type ActivityDay = {
  date: Date;
  dateKey: string;
  weekIndex: number;
  weekdayIndex: number;
  wordCount: number;
  level: number;
  isFuture: boolean;
};

export type ActivityMonthLabel = {
  date: Date;
  weekIndex: number;
  span: number;
};

export type ActivityGrid = {
  startDate: string;
  endDate: string;
  today: Date;
  weeks: ActivityDay[][];
  monthLabels: ActivityMonthLabel[];
};

const addLocalDays = (date: Date, amount: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);

/** Monday-first range for 26 visible week columns, ending on the local date. */
export const getActivityDateRange = (
  now: Date = new Date(),
): { startDate: string; endDate: string } => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (today.getDay() + 6) % ACTIVITY_DAYS_PER_WEEK;
  const currentWeekMonday = addLocalDays(today, -mondayOffset);
  const firstWeekMonday = addLocalDays(
    currentWeekMonday,
    -(ACTIVITY_WEEKS - 1) * ACTIVITY_DAYS_PER_WEEK,
  );
  return {
    startDate: localDateKey(firstWeekMonday),
    endDate: localDateKey(today),
  };
};

const quantile = (sortedValues: number[], fraction: number): number => {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  return sortedValues[index] ?? 0;
};

const buildMonthLabels = (weeks: ActivityDay[][]): ActivityMonthLabel[] => {
  const candidates: Array<{ date: Date; weekIndex: number }> = [];
  const seenMonths = new Set<string>();

  for (const [weekIndex, week] of weeks.entries()) {
    const monthStart = week.find((day) => day.date.getDate() === 1);
    const candidate = monthStart ?? (weekIndex === 0 ? week[0] : undefined);
    if (!candidate) continue;

    const key = `${candidate.date.getFullYear()}-${candidate.date.getMonth()}`;
    if (seenMonths.has(key)) continue;
    seenMonths.add(key);
    candidates.push({ date: candidate.date, weekIndex });
  }

  return candidates.map((candidate, index) => ({
    ...candidate,
    span:
      (candidates[index + 1]?.weekIndex ?? ACTIVITY_WEEKS) -
      candidate.weekIndex,
  }));
};

export const buildActivityGrid = (
  records: DailyWordActivity[],
  asOfDate: Date = new Date(),
): ActivityGrid => {
  const range = getActivityDateRange(asOfDate);
  const today = dateFromLocalKey(range.endDate);
  const start = dateFromLocalKey(range.startDate);
  const countsByDate = new Map<string, number>();

  for (const record of records) {
    if (
      record.localDate < range.startDate ||
      record.localDate > range.endDate
    ) {
      continue;
    }
    const count = Number.isFinite(record.wordCount)
      ? Math.max(0, Math.trunc(record.wordCount))
      : 0;
    if (count <= 0) continue;
    countsByDate.set(
      record.localDate,
      (countsByDate.get(record.localDate) ?? 0) + count,
    );
  }

  const positiveCounts = [...countsByDate.values()].sort((a, b) => a - b);
  const thresholds = [
    quantile(positiveCounts, 0.25),
    quantile(positiveCounts, 0.5),
    quantile(positiveCounts, 0.75),
  ];
  const levelForCount = (wordCount: number): number => {
    if (wordCount <= 0) return 0;
    if (wordCount <= thresholds[0]!) return 1;
    if (wordCount <= thresholds[1]!) return 2;
    if (wordCount <= thresholds[2]!) return 3;
    return 4;
  };

  const weeks: ActivityDay[][] = Array.from(
    { length: ACTIVITY_WEEKS },
    (_, weekIndex) =>
      Array.from({ length: ACTIVITY_DAYS_PER_WEEK }, (_, weekdayIndex) => {
        const date = addLocalDays(
          start,
          weekIndex * ACTIVITY_DAYS_PER_WEEK + weekdayIndex,
        );
        const dateKey = localDateKey(date);
        const isFuture = date > today;
        const wordCount = isFuture ? 0 : (countsByDate.get(dateKey) ?? 0);
        return {
          date,
          dateKey,
          weekIndex,
          weekdayIndex,
          wordCount,
          level: levelForCount(wordCount),
          isFuture,
        };
      }),
  );

  return {
    ...range,
    today,
    weeks,
    monthLabels: buildMonthLabels(weeks),
  };
};

export const getActivityDay = (
  weeks: ActivityDay[][],
  weekIndex: number,
  weekdayIndex: number,
): ActivityDay | undefined => weeks[weekIndex]?.[weekdayIndex];

/** Move within the single-roving-focus calendar, skipping future cells. */
export const moveActivityFocus = (
  weeks: ActivityDay[][],
  current: { weekIndex: number; weekdayIndex: number },
  delta: { week: number; weekday: number },
): { weekIndex: number; weekdayIndex: number } => {
  let weekIndex = current.weekIndex + delta.week;
  let weekdayIndex = current.weekdayIndex + delta.weekday;

  while (
    weekIndex >= 0 &&
    weekIndex < ACTIVITY_WEEKS &&
    weekdayIndex >= 0 &&
    weekdayIndex < ACTIVITY_DAYS_PER_WEEK
  ) {
    const day = getActivityDay(weeks, weekIndex, weekdayIndex);
    if (day && !day.isFuture) return { weekIndex, weekdayIndex };
    weekIndex += delta.week === 0 ? 0 : Math.sign(delta.week);
    weekdayIndex += delta.weekday === 0 ? 0 : Math.sign(delta.weekday);
  }

  return current;
};
