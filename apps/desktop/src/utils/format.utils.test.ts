import { describe, expect, it } from "vitest";
import { formatMediumDate, formatMediumDateTime } from "./format.utils";

describe("formatMediumDate", () => {
  it("returns null for empty and missing values", () => {
    expect(formatMediumDate(null)).toBeNull();
    expect(formatMediumDate(undefined)).toBeNull();
    expect(formatMediumDate("")).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(formatMediumDate("not-a-date")).toBeNull();
  });

  it("formats a valid ISO date", () => {
    const formatted = formatMediumDate("2026-11-13T20:09:00Z");
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("2026");
  });
});

describe("formatMediumDateTime", () => {
  it("returns null for empty and missing values", () => {
    expect(formatMediumDateTime(null)).toBeNull();
    expect(formatMediumDateTime(undefined)).toBeNull();
    expect(formatMediumDateTime("")).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(formatMediumDateTime("not-a-date")).toBeNull();
    expect(formatMediumDateTime(Number.NaN)).toBeNull();
  });

  it("accepts a numeric timestamp", () => {
    // The epoch is a valid instant, so it must format rather than return null.
    const formatted = formatMediumDateTime(0);
    expect(formatted).not.toBeNull();
  });

  it("formats a valid ISO date", () => {
    const formatted = formatMediumDateTime("2026-11-13T20:09:00Z");
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("2026");
  });
});
