/**
 * Appends each non-blank value as its own occurrence of `name` on a query
 * string. Repeated parameters are the documented wire format for vocabulary
 * hints such as Deepgram `keyterm` and ElevenLabs `keyterms`. Values are
 * trimmed and blank entries skipped once here, so every call site stays
 * consistent without repeating the guard.
 */
export const appendQueryParamValues = (
  params: URLSearchParams,
  name: string,
  values: readonly string[],
): void => {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      params.append(name, trimmed);
    }
  }
};
