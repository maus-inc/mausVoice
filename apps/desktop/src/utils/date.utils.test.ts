import { describe, expect, it } from "vitest";
import { createIntl } from "react-intl";
import { formatShortDate, formatShortTime, nowIso } from "./date.utils";

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

describe("nowIso", () => {
  it("returns a valid ISO string for the current time", () => {
    expect(() => new Date(nowIso())).not.toThrow();
    expect(new Date(nowIso()).toString()).not.toBe("Invalid Date");
  });
});
