/** Format a valid release timestamp for the current locale. */
export const formatReleaseDate = (
  isoDate: string | null,
  includeTime = false,
): string | null => {
  if (!isoDate) return null;
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = includeTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(undefined, options).format(parsed);
};
