import { describe, expect, it } from "vitest";
import { createIntl } from "react-intl";
import {
  dateFromLocalDateKey,
  formatShortDate,
  formatShortTime,
  localDateKeyFromIso,
  nowIso,
  threadDayGroup,
  toLocalDateKey,
  toLocalMonthKey,
} from "./date.utils";

const intl = createIntl({ locale: "en" });

// Dates are built from local components so the expected strings hold on any
// runner timezone.
const localIso = (
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
) => new Date(year, monthIndex, day, hour, 40).toISOString();

describe("formatShortDate", () => {
  it("formats a timestamp as a short date", () => {
    const currentYear = new Date().getFullYear();
    expect(formatShortDate(intl, localIso(currentYear, 7, 25, 22))).toBe(
      "Aug 25",
    );
  });

  it("appends the year when the timestamp is not from the current year", () => {
    const oldYear = new Date().getFullYear() - 2;
    expect(formatShortDate(intl, localIso(oldYear, 7, 25, 22))).toBe(
      `Aug 25, ${oldYear}`,
    );
  });
});

describe("formatShortTime", () => {
  it("formats a timestamp as a compact time", () => {
    const currentYear = new Date().getFullYear();
    expect(formatShortTime(intl, localIso(currentYear, 7, 25, 22))).toBe(
      "10:40 PM",
    );
    expect(formatShortTime(intl, localIso(currentYear, 7, 25, 10))).toBe(
      "10:40 AM",
    );
  });
});

describe("threadDayGroup", () => {
  it("buckets local calendar days into today, yesterday, and earlier", () => {
    const now = new Date(2026, 8, 8, 18, 0);
    expect(threadDayGroup(new Date(2026, 8, 8, 9, 0).toISOString(), now)).toBe(
      "today",
    );
    expect(threadDayGroup(new Date(2026, 8, 7, 23, 0).toISOString(), now)).toBe(
      "yesterday",
    );
    expect(threadDayGroup(new Date(2026, 8, 6, 12, 0).toISOString(), now)).toBe(
      "earlier",
    );
  });
});

describe("local date keys", () => {
  it("round-trips local dates without shifting them through UTC", () => {
    const localDate = new Date(2024, 1, 29, 23, 45);
    const key = toLocalDateKey(localDate);

    expect(key).toBe("2024-02-29");
    expect(dateFromLocalDateKey(key).getHours()).toBe(12);
    expect(toLocalDateKey(dateFromLocalDateKey(key))).toBe(key);
    expect(localDateKeyFromIso(localDate.toISOString())).toBe(key);
    expect(toLocalMonthKey(localDate)).toBe("2024-02");
  });

  it.each(["2024-2-09", "2023-02-29", "2024-04-31", "nope"])(
    "rejects an invalid local date key: %s",
    (key) => {
      expect(() => dateFromLocalDateKey(key)).toThrow(RangeError);
    },
  );
});

describe("nowIso", () => {
  it("returns a valid ISO string for the current time", () => {
    expect(() => new Date(nowIso())).not.toThrow();
    expect(new Date(nowIso()).toString()).not.toBe("Invalid Date");
  });
});
