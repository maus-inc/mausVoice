/**
 * Small helpers for mapping loose Tauri-boundary values onto the typed
 * preference/user objects without sprinkling `??` chains through every
 * mapping function.
 */
export const orNull = <T>(value: T | null | undefined): T | null =>
  value ?? null;

export const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

export const orFalse = (value: boolean | null | undefined): boolean =>
  value ?? false;

export const orTrue = (value: boolean | null | undefined): boolean =>
  value ?? true;

export const orValue = <T>(value: T | null | undefined, fallback: T): T =>
  value ?? fallback;
