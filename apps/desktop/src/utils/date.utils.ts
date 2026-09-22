import type { IntlShape } from "react-intl";

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
