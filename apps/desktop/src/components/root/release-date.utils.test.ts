import { describe, expect, it } from "vitest";
import { formatReleaseDate } from "./release-date.utils";

describe("formatReleaseDate", () => {
  it("returns null for missing or invalid dates", () => {
    expect(formatReleaseDate(null)).toBeNull();
    expect(formatReleaseDate("")).toBeNull();
    expect(formatReleaseDate("invalid")).toBeNull();
  });

  it("preserves the date-only and date-time presentation for the current locale", () => {
    const value = "2026-01-02T15:30:00.000Z";
    const date = new Date(value);
    expect(formatReleaseDate(value)).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date),
    );
    expect(formatReleaseDate(value, true)).toBe(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date),
    );
  });
});
