import { commands } from "@maus-inc/desktop-native-apis";

/**
 * Ask the native pill to publish its current geometry on
 * `pill-position-changed`. Throws when this session has no native pill.
 */
export const requestPillPosition = async (): Promise<void> => {
  const result = await commands.requestPillPosition();
  if (result.status === "error") {
    throw new Error(result.error);
  }
};

/**
 * Whether this session runs the native pill overlay.
 *
 * Asking the pill for its position is the cheapest honest probe: it only
 * succeeds when a native pill is available, and it fails on the Tauri-overlay
 * fallback. The answer cannot change without restarting the app, so it is
 * resolved once and reused.
 */
let availability: Promise<boolean> | null = null;

export const isNativePillAvailable = (): Promise<boolean> => {
  availability ??= requestPillPosition().then(
    () => true,
    () => false,
  );
  return availability;
};

/** Test seam: forget the cached probe result. */
export const resetNativePillAvailability = (): void => {
  availability = null;
};
