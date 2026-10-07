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
 *
 * The wipe itself works from `APP_DATA_STORAGE_PREFIXES` rather than from this
 * list, because some of what the app owns is named per item (agent tool
 * auto-approvals are per tool and per scope) or was named by a feature that
 * came later. A wipe that enumerates keys is only complete until the next key
 * is added; one that works from the namespaces stays complete on its own.
 */
export const LOCAL_STATE_STORAGE_KEY = "mausvoice-local-state";
export const PREVIEW_LOCAL_STATE_STORAGE_KEY =
  "mausvoice-browser-preview-local-state";
export const LEGACY_LOCAL_STATE_STORAGE_KEY = "voquill-local-state";
export const ACCOUNT_CREATED_AT_STORAGE_KEY = "mausvoice:account-created-at";
export const ONBOARDED_AT_STORAGE_KEY = "mausvoice:onboarded-at";
export const LAST_SETTINGS_PAGE_STORAGE_KEY = "maus-settings-last-page";

/**
 * The keys a local-data wipe is expected to find, named for the writers that
 * use them. Kept as documentation of what lives under the prefixes below, and
 * as the export each owner imports instead of spelling its own key.
 *
 * It includes both store keys because the browser preview writes the preview
 * name while the desktop app writes the other, and a build can be wiped through
 * either entry point. The preview entry is written by the browser preview only,
 * so a desktop wipe finds nothing under it and that is fine.
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
 * The namespaces this app writes localStorage under.
 *
 * Firebase's own keys (`firebase:authUser:*` and friends) are deliberately
 * outside every one of them: they hold the signed-in session, and clearing
 * local data is not a sign-out. Everything else on this origin was written by
 * this app, including the legacy `voquill-local-state` carried over from
 * before the rebrand and the per-tool `tool_always_allow:*` grants, which is
 * why the last one is a prefix rather than a key: leaving an auto-approval
 * behind would let an agent tool run after the reset without asking again.
 */
export const TOOL_ALWAYS_ALLOW_STORAGE_PREFIX = "tool_always_allow:";

export const APP_DATA_STORAGE_PREFIXES = [
  "mausvoice",
  "voquill",
  "maus-settings",
  TOOL_ALWAYS_ALLOW_STORAGE_PREFIX,
];

/** Every stored key the wipe is about to remove. */
const listAppDataStorageKeys = (storage: Storage): string[] => {
  const keys: string[] = [];
  // Snapshot before removing: `storage.length` and the indices shift under
  // every removal, so a loop that deletes as it walks skips keys.
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (
      key &&
      APP_DATA_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      keys.push(key);
    }
  }
  return keys;
};

/**
 * Remove everything this app keeps in localStorage.
 *
 * Returns the keys the browser refused to delete, so a caller that made a
 * promise about them can say the promise was not kept instead of reloading
 * into the data it claimed to have removed. One key failing does not abort the
 * rest of the wipe: a half-applied wipe that reports which half is more useful
 * than one that stops at the first refusal.
 */
export const clearAppDataStorage = (): string[] => {
  const storage = getLocalStorage();
  if (!storage) return [];

  const failed: string[] = [];
  for (const key of listAppDataStorageKeys(storage)) {
    try {
      storage.removeItem(key);
    } catch (e) {
      console.error(`Unable to clear ${key} from localStorage:`, e);
      failed.push(key);
    }
  }
  return failed;
};
