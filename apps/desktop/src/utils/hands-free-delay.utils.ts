const MIN_HANDS_FREE_DELAY_MS = 0;
const MAX_HANDS_FREE_DELAY_MS = 60_000;

export const DEFAULT_HANDS_FREE_DELAY_MS = 0;

export { MAX_HANDS_FREE_DELAY_MS };

export const isHandsFreeDelayEnabled = (
  value: number | null | undefined,
): boolean => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }
  return value > 0;
};

export const normalizeHandsFreeDelayMs = (
  value: number | null | undefined,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_HANDS_FREE_DELAY_MS;
  }

  return Math.min(
    MAX_HANDS_FREE_DELAY_MS,
    Math.max(MIN_HANDS_FREE_DELAY_MS, Math.floor(value)),
  );
};

export const getEffectiveHandsFreeDelayMs = (
  preferences: { handsFreeDelayMs?: number | null } | null | undefined,
): number => normalizeHandsFreeDelayMs(preferences?.handsFreeDelayMs);

export const MAX_HANDS_FREE_DELAY_SECONDS = MAX_HANDS_FREE_DELAY_MS / 1000;

/**
 * Milliseconds as seconds for the settings field, without trailing zeros, so
 * the stored 2000 reads as "2" and a stored 2500 reads as "2.5" rather than
 * being rounded into a value the app will not actually use.
 */
export const formatHandsFreeDelaySeconds = (milliseconds: number): string => {
  const seconds = normalizeHandsFreeDelayMs(milliseconds) / 1000;
  return String(Number(seconds.toFixed(3)));
};

/**
 * Parses the seconds field. Returns milliseconds to store, or null when the
 * input is not a usable delay (empty, not a number, negative, or beyond the
 * maximum), which the field reports instead of silently changing.
 */
export const parseHandsFreeDelaySeconds = (input: string): number | null => {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }

  const seconds = Number(trimmed);
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_HANDS_FREE_DELAY_SECONDS
  ) {
    return null;
  }

  return normalizeHandsFreeDelayMs(Math.round(seconds * 1000));
};
