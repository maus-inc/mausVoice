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
  preferences: { handsFreeDelayMs?: number | null | undefined } | null | undefined,
): number => normalizeHandsFreeDelayMs(preferences?.handsFreeDelayMs);
