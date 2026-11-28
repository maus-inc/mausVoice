/** Parse a JSON object, rejecting malformed JSON and non-object roots. */
export const parseJsonObject = (
  text: string,
): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};
