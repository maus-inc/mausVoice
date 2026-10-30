import { getLocalStorage } from "./local-storage.utils";
import { disableAnalyticsPersistenceForLocalDataClear } from "./analytics-persistence.utils";
import { LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY } from "./local-data-write-gate";

const APP_LOCAL_STORAGE_PREFIXES = [
  "mausvoice",
  "voquill",
  "tool_always_allow:",
  // Mixpanel's durable request queues and SharedLock keys.
  "__mpq_",
] as const;

const APP_LOCAL_STORAGE_KEYS = new Set([
  "mode",
  "mui-mode",
  "mui-color-scheme",
  // Mixpanel uses the configured persistence name directly for secondary
  // windows rather than its usual `mp_<token>_mixpanel` key.
  "mp_mausvoice-secondary-window",
]);

const isAppOwnedLocalStorageKey = (key: string): boolean =>
  APP_LOCAL_STORAGE_KEYS.has(key) ||
  APP_LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
  /^mp_.*_mixpanel$/.test(key);

/** Removes app-owned browser state without touching Firebase or other SDK data. */
export const clearAppLocalStorage = (): void => {
  const storage = getLocalStorage();
  if (!storage) {
    throw new Error(
      "Browser storage is unavailable, so local settings remain.",
    );
  }

  disableAnalyticsPersistenceForLocalDataClear();

  const keysToRemove: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key != null &&
        key !== LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY &&
        isAppOwnedLocalStorageKey(key)
      ) {
        keysToRemove.push(key);
      }
    }
  } catch (error) {
    throw new Error("Unable to list app-owned browser storage keys.", {
      cause: error,
    });
  }

  const failedKeys: string[] = [];
  for (const key of keysToRemove) {
    try {
      storage.removeItem(key);
    } catch {
      failedKeys.push(key);
    }
  }

  if (failedKeys.length > 0) {
    throw new Error(
      `Unable to clear app-owned browser storage keys: ${failedKeys.join(", ")}`,
    );
  }
};

/** Remove the interruption latch only after native and browser data are clear. */
export const removeLocalDataClearPendingMarker = (): void => {
  const storage = getLocalStorage();
  if (!storage) {
    throw new Error(
      "Browser storage is unavailable, so local settings remain.",
    );
  }

  try {
    storage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
  } catch (error) {
    throw new Error("Unable to finish the local-data clear marker.", {
      cause: error,
    });
  }
};
