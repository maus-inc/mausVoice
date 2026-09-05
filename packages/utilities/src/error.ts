/**
 * Coerce any thrown value to a readable message without producing
 * `[object Object]` for plain objects.
 */
export const unknownToMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};
