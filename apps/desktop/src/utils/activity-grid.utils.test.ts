import { describe, expect, it } from "vitest";
import { localDateKey } from "./date.utils";
import {
  ACTIVITY_DAYS_PER_WEEK,
  ACTIVITY_WEEKS,
  buildActivityGrid,
  getActivityDateRange,
} from "./activity-grid.utils";

const localDate = (year: number, month: number, day: number): Date =>
  new Date(year, month - 1, day);

describe("home activity calendar", () => {
  it("builds 26 Monday-first week columns through the current local day", () => {
    const now = localDate(2026, 10, 6);
    const grid = buildActivityGrid([], now);

    expect(grid.weeks).toHaveLength(ACTIVITY_WEEKS);
    expect(
      grid.weeks.every((week) => week.length === ACTIVITY_DAYS_PER_WEEK),
    ).toBe(true);
    expect(grid.weeks[0]?.[0]?.date.getDay()).toBe(1);
    expect(grid.weeks.flat().at(-1)?.dateKey).toBe("2026-10-11");
    expect(grid.endDate).toBe("2026-10-06");
    expect(grid.weeks.flat().filter((day) => !day.isFuture)).toHaveLength(
      25 * 7 + 2,
    );
    expect(getActivityDateRange(now).startDate).toBe(
      grid.weeks[0]?.[0]?.dateKey,
    );
  });

  it("uses distinct zero and ordered quartile levels without splitting ties", () => {
    const now = localDate(2026, 10, 6);
    const days = buildActivityGrid([], now).weeks.flat();
    const values = [1, 1, 2, 3, 10_000];
    const records = values.map((wordCount, index) => ({
      localDate: days[index]!.dateKey,
      wordCount,
    }));
    const grid = buildActivityGrid(records, now);

    expect(grid.weeks.flat()[0]?.level).toBe(1);
    expect(grid.weeks.flat()[1]?.level).toBe(1);
    expect(grid.weeks.flat()[2]?.level).toBe(2);
    expect(grid.weeks.flat()[3]?.level).toBe(3);
    expect(grid.weeks.flat()[4]?.level).toBe(4);
    expect(grid.weeks.flat()[5]?.level).toBe(0);
  });

  it("does not manufacture shade distinctions when all active values tie", () => {
    const now = localDate(2026, 10, 6);
    const days = buildActivityGrid([], now).weeks.flat();
    const grid = buildActivityGrid(
      [0, 1, 2].map((index) => ({
        localDate: days[index]!.dateKey,
        wordCount: 8,
      })),
      now,
    );

    expect(
      grid.weeks
        .flat()
        .slice(0, 3)
        .map((day) => day.level),
    ).toEqual([1, 1, 1]);
  });

  it("keeps future dates blank even if a malformed response contains them", () => {
    const now = localDate(2026, 10, 6);
    const futureKey = "2026-10-07";
    const grid = buildActivityGrid(
      [{ localDate: futureKey, wordCount: 99 }],
      now,
    );
    const future = grid.weeks.flat().find((day) => day.dateKey === futureKey);

    expect(future?.isFuture).toBe(true);
    expect(future?.wordCount).toBe(0);
    expect(future?.level).toBe(0);
  });

  it("aligns leap days, month boundaries, and year labels to local dates", () => {
    const grid = buildActivityGrid([], localDate(2024, 2, 29));
    const dates = grid.weeks.flat().map((day) => day.dateKey);

    expect(dates).toContain("2024-02-29");
    expect(dates).toContain("2024-01-01");
    expect(dates).toContain("2023-12-31");
    expect(grid.endDate).toBe("2024-02-29");
    expect(
      grid.monthLabels.some((label) => label.date.getFullYear() === 2023),
    ).toBe(true);
    expect(localDateKey(grid.today)).toBe("2024-02-29");
  });

  it("keeps local day keys contiguous across daylight-saving transitions", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";

    try {
      const spring = buildActivityGrid([], new Date(2026, 2, 9, 12));
      const springDates = spring.weeks.flat().map((day) => day.dateKey);
      expect(springDates).toContain("2026-03-08");
      expect(springDates).toContain("2026-03-09");
      expect(
        new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime(),
      ).toBe(23 * 60 * 60 * 1000);

      const fall = buildActivityGrid([], new Date(2026, 10, 2, 12));
      const fallDates = fall.weeks.flat().map((day) => day.dateKey);
      expect(fallDates).toContain("2026-11-01");
      expect(fallDates).toContain("2026-11-02");
      expect(
        new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime(),
      ).toBe(25 * 60 * 60 * 1000);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("drops totals outside the 26 visible columns", () => {
    const now = localDate(2026, 10, 6);
    const firstDay = buildActivityGrid([], now).weeks.flat()[0]!;
    const outside = localDateKey(localDate(2025, 1, 1));
    const grid = buildActivityGrid(
      [
        { localDate: firstDay.dateKey, wordCount: 4 },
        { localDate: outside, wordCount: 100_000 },
      ],
      now,
    );

    expect(grid.weeks.flat()[0]?.wordCount).toBe(4);
    expect(grid.weeks.flat()[0]?.level).toBe(1);
  });
});
