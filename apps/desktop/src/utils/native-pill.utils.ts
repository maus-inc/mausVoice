import { invoke } from "@tauri-apps/api/core";

/**
 * Whether this session runs the native pill overlay.
 *
 * `request_pill_position` is the cheapest honest probe: it only succeeds when
 * a managed native pill process (or the in-process macOS pill) is available,
 * and it fails with an error on the Tauri-overlay fallback. The answer cannot
 * change without restarting the app, so it is resolved once and reused.
 */
let availability: Promise<boolean> | null = null;

export const isNativePillAvailable = (): Promise<boolean> => {
  availability ??= invoke("request_pill_position")
    .then(() => true)
    .catch(() => false);
  return availability;
};

/** Test seam: forget the cached probe result. */
export const resetNativePillAvailability = (): void => {
  availability = null;
};
