export const getLocalStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch (e) {
    console.error("Unable to access localStorage:", e);
    return null;
  }
};

export const getLocalStorageBool = (key: string): boolean => {
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    const raw = storage.getItem(key);
    return raw !== null ? JSON.parse(raw) === true : false;
  } catch {
    return false;
  }
};

export const getLocalStorageString = (key: string): string | null => {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
};

export const setLocalStorageString = (key: string, value: string): void => {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch (e) {
    console.error("Unable to write localStorage:", e);
  }
};

/**
 * Every localStorage key this app owns, named in one place.
 *
 * The store, the account-anchor repo and the settings routes all write here,
 * and "clear local data" has to remove all of it. Spelling the keys once and
 * importing them at the writers keeps that list honest: a key that only exists
 * as a literal inside its owner is a key the wipe silently misses.
 */
export const LOCAL_STATE_STORAGE_KEY = "mausvoice-local-state";
export const PREVIEW_LOCAL_STATE_STORAGE_KEY =
  "mausvoice-browser-preview-local-state";
export const LEGACY_LOCAL_STATE_STORAGE_KEY = "voquill-local-state";
export const ACCOUNT_CREATED_AT_STORAGE_KEY = "mausvoice:account-created-at";
export const ONBOARDED_AT_STORAGE_KEY = "mausvoice:onboarded-at";
export const LAST_SETTINGS_PAGE_STORAGE_KEY = "maus-settings-last-page";

/**
 * The keys a local-data wipe must remove.
 *
 * Firebase's own keys are deliberately absent: they hold the signed-in session,
 * and clearing local data is not a sign-out. Everything here is state this app
 * wrote about the person on this device, so leaving any of it behind would
 * contradict the promise the dialog makes. It includes both store keys because
 * the browser preview writes the preview name while the desktop app writes the
 * other, and a build can be wiped through either entry point.
 */
export const APP_DATA_STORAGE_KEYS = [
  LOCAL_STATE_STORAGE_KEY,
  PREVIEW_LOCAL_STATE_STORAGE_KEY,
  LEGACY_LOCAL_STATE_STORAGE_KEY,
  ACCOUNT_CREATED_AT_STORAGE_KEY,
  ONBOARDED_AT_STORAGE_KEY,
  LAST_SETTINGS_PAGE_STORAGE_KEY,
];

/**
 * Remove everything in `APP_DATA_STORAGE_KEYS`, ignoring failures.
 *
 * Callers run this immediately before reloading the window, and the reload is
 * what flushes the in-memory store, so a storage that refuses to delete one key
 * must not abort the wipe half-applied.
 */
export const clearAppDataStorage = (): void => {
  const storage = getLocalStorage();
  if (!storage) return;
  for (const key of APP_DATA_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch (e) {
      console.error(`Unable to clear ${key} from localStorage:`, e);
    }
  }
};
