import type { IntlShape } from "react-intl";

export const nowIso = (): string => {
  return new Date().toISOString();
};

/**
 * Compact short date for chat surfaces, e.g. "Aug 25". The year is only
 * appended when the timestamp is not from the current year, so recent
 * activity stays short while older entries stay unambiguous.
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

/** Compact time for chat surfaces, e.g. "10:40 PM". */
export const formatShortTime = (intl: IntlShape, isoDate: string): string =>
  intl.formatTime(new Date(isoDate), {
    hour: "numeric",
    minute: "2-digit",
  });
