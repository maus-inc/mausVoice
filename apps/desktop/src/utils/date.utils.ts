import type { IntlShape } from "react-intl";

/** A stable local-calendar key for activity days and SQLite comparisons. */
export const toLocalDateKey = (date: Date): string => {
  if (!Number.isFinite(date.valueOf())) {
    throw new RangeError("Cannot format an invalid date as a local date key");
  }
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/** Convert a persisted instant to the device's local calendar day. */
export const localDateKeyFromIso = (isoDate: string): string =>
  toLocalDateKey(new Date(isoDate));

/** Parse a validated YYYY-MM-DD key into local noon without UTC shifting. */
export const dateFromLocalDateKey = (localDate: string): Date => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new RangeError("Expected a YYYY-MM-DD local date key");
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  );
  if (toLocalDateKey(date) !== localDate) {
    throw new RangeError("Expected a valid local calendar date");
  }
  return date;
};

/** Local year/month key used by profile word totals. */
export const toLocalMonthKey = (date: Date): string =>
  `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1)
    .toString()
    .padStart(2, "0")}`;

export const nowIso = (): string => {
  return new Date().toISOString();
};

/**
 * Compact short date for chat surfaces, e.g. "Aug 25". The year is only
 * appended when the timestamp is not from the current year, so recent
 * activity stays short while older entries stay unambiguous. Both years
 * come from local time, matching the local-timezone formatting that
 * react-intl applies below.
 */
export const formatShortDate = (intl: IntlShape, isoDate: string): string => {
  const date = new Date(isoDate);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return intl.formatDate(date, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
};

/** assistant-ui thread-list day buckets, local calendar days. */
export type ThreadDayGroup = "today" | "yesterday" | "earlier";

export const threadDayGroup = (
  isoDate: string,
  now: Date = new Date(),
): ThreadDayGroup => {
  const date = new Date(isoDate);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startYesterday.getDate() - 1);
  if (date >= startToday) return "today";
  if (date >= startYesterday) return "yesterday";
  return "earlier";
};

/** Compact time for chat surfaces, e.g. "10:40 PM". */
export const formatShortTime = (intl: IntlShape, isoDate: string): string =>
  intl.formatTime(new Date(isoDate), {
    hour: "numeric",
    minute: "2-digit",
  });
