import { describe, expect, it } from "vitest";
import type { DailyWordActivity } from "../types/home.types";
import { dateFromLocalDateKey, toLocalDateKey } from "./date.utils";
import {
  activityIntensity,
  buildActivityGrid,
  getActivityDateRange,
} from "./activity-grid.utils";

describe("activityIntensity", () => {
  it.each([
    [0, 0],
    [1, 1],
    [99, 1],
    [100, 2],
    [499, 2],
    [500, 3],
    [1_499, 3],
    [1_500, 4],
  ] as const)("maps %i words to intensity %i", (words, expected) => {
    expect(activityIntensity(words)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "treats non-finite word counts as empty activity (%s)",
    (wordCount) => {
      expect(activityIntensity(wordCount)).toBe(0);
    },
  );
});

describe("buildActivityGrid", () => {
  it("returns 53 Sunday-first weeks and marks only dates through today", () => {
    const today = new Date(2026, 9, 8, 18, 30);
    const grid = buildActivityGrid([], today);
    const allCells = grid.weeks.flat();
    const first = dateFromLocalDateKey(grid.startDate);
    const todayKey = toLocalDateKey(today);

    expect(grid.weeks).toHaveLength(53);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    expect(first.getDay()).toBe(0);
    expect(
      grid.weeks[0].map((cell) =>
        dateFromLocalDateKey(cell.localDate).getDay(),
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(allCells.filter((cell) => cell.isToday)).toHaveLength(1);
    expect(allCells.find((cell) => cell.isToday)?.localDate).toBe(todayKey);
    expect(allCells.at(-1)?.isFuture).toBe(true);
    expect(allCells.filter((cell) => cell.isFuture).length).toBe(
      6 - today.getDay(),
    );
  });

  it("places daily totals on their local date and derives intensity", () => {
    const today = new Date(2026, 4, 20, 12);
    const localDate = toLocalDateKey(new Date(2026, 4, 18, 23, 30));
    const activity: DailyWordActivity[] = [
      { localDate, wordCount: 250 },
      { localDate, wordCount: 50 },
      { localDate: "2024-01-01", wordCount: 99_000 },
    ];

    const grid = buildActivityGrid(activity, today);
    const cell = grid.weeks
      .flat()
      .find((candidate) => candidate.localDate === localDate);

    expect(cell).toMatchObject({
      wordCount: 300,
      intensity: 2,
      isToday: false,
      isFuture: false,
    });
  });

  it("keeps the seven calendar rows continuous across daylight-saving changes", () => {
    const before = new Date(2024, 2, 10, 12);
    const grid = buildActivityGrid([], before, 4);
    const dates = grid.weeks
      .flat()
      .map((cell) => dateFromLocalDateKey(cell.localDate));

    for (let index = 1; index < dates.length; index += 1) {
      const expected = new Date(dates[index - 1]);
      expected.setDate(expected.getDate() + 1);
      expect(toLocalDateKey(dates[index])).toBe(toLocalDateKey(expected));
    }
  });

  it("builds ranges before year 100 without remapping the calendar year", () => {
    const today = dateFromLocalDateKey("0001-01-04");
    const grid = buildActivityGrid([], today, 1);

    expect(grid.endDate).toBe("0001-01-04");
    expect(grid.weeks).toHaveLength(1);
    expect(grid.weeks[0]).toHaveLength(7);
  });

  it("rejects a non-positive week count", () => {
    expect(() => getActivityDateRange(new Date(), 0)).toThrow(RangeError);
  });
});
