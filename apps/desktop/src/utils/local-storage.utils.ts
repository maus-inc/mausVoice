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
 * The theme mode MUI persists. It is the app's own appearance preference: the
 * bootstrap in `index.html` reads it before first paint, and `theme.ts` hands it
 * to the provider as `modeStorageKey`.
 */
export const THEME_MODE_STORAGE_KEY = "mui-mode";
/**
 * The mode key used before the current one. `index.html` migrates it on boot and
 * deliberately keeps it, so a rollback still finds the person's choice; a wipe
 * has to remove both.
 */
export const LEGACY_THEME_MODE_STORAGE_KEY = "mode";

/**
 * The keys a local-data wipe removes by name, and the export each owner imports
 * instead of spelling its own key.
 *
 * Most of them also sit under a namespace below, and are listed anyway because
 * naming them is what keeps the writers and the wipe in step. The theme keys are
 * the exception: `mui-mode` and its predecessor `mode` are bare words, so they
 * are here rather than in a namespace that would have to be dangerously broad.
 *
 * Both store keys are listed because the browser preview writes the preview name
 * while the desktop app writes the other, and a build can be wiped through
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
  THEME_MODE_STORAGE_KEY,
  LEGACY_THEME_MODE_STORAGE_KEY,
];

/**
 * The namespaces this app writes localStorage under.
 *
 * Firebase's own keys (`firebase:authUser:*` and friends) are deliberately
 * outside every one of them: they hold the signed-in session, and clearing
 * local data is not a sign-out. Everything else on this origin was written by
 * this app. That includes the legacy `voquill-local-state` carried over from
 * before the rebrand, the per-tool `tool_always_allow:*` grants, and the
 * onboarding checklist, denied auto-learn terms and pending transcription
 * deletes that later features added under the `mausvoice` namespace, which is
 * exactly why these are prefixes: a key list only covers the keys it was
 * written next to.
 */
export const TOOL_ALWAYS_ALLOW_STORAGE_PREFIX = "tool_always_allow:";

export const APP_DATA_STORAGE_PREFIXES = [
  "mausvoice",
  "voquill",
  "maus-settings",
  TOOL_ALWAYS_ALLOW_STORAGE_PREFIX,
];

/** A lookup over the named keys above, kept for the walk below. */
const APP_DATA_STORAGE_KEY_SET = new Set<string>(APP_DATA_STORAGE_KEYS);

/**
 * Whether the app owns a stored key.
 *
 * Two ways to own one: the key sits under a namespace above, or it is one of
 * the names in `APP_DATA_STORAGE_KEYS`. The second is not redundant: the theme
 * mode and its predecessor are bare `mui-mode` and `mode`, which no namespace
 * can cover without matching keys that are not ours.
 */
const isAppOwnedStorageKey = (key: string): boolean =>
  APP_DATA_STORAGE_KEY_SET.has(key) ||
  APP_DATA_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));

/** Every stored key the wipe is about to remove. */
const listAppDataStorageKeys = (storage: Storage): string[] => {
  const keys: string[] = [];
  // Snapshot before removing: `storage.length` and the indices shift under
  // every removal, so a loop that deletes as it walks skips keys.
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && isAppOwnedStorageKey(key)) {
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
