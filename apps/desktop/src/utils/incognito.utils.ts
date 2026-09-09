/**
 * Single gate for the privacy modes that suppress persistence. Incognito mode is
 * a stored preference, while an ephemeral session is scoped to one run of the
 * app. Both are answered here so a new persistence call site has one helper to
 * consult rather than two flags to remember.
 */
import { getAppState } from "../store";

/**
 * Check whether incognito mode is currently enabled.
 */
export const isIncognitoModeEnabled = (): boolean => {
  return getAppState().userPrefs?.incognitoModeEnabled ?? false;
};

/**
 * Check whether an ephemeral session is in progress. Unlike incognito mode
 * this is scoped to one run of the app and is never persisted.
 */
export const isEphemeralSessionActive = (): boolean => {
  return getAppState().local.ephemeralSessionActive;
};

/**
 * Check whether data persistence is allowed. Persistence is suppressed while
 * incognito mode is on or an ephemeral session is in progress.
 *
 * Both paths that store a new transcription call this helper, the local
 * `storeTranscription` and the remote transcript store, so the invariant lives
 * in one place.
 */
export const isPersistenceAllowed = (): boolean => {
  return !isIncognitoModeEnabled() && !isEphemeralSessionActive();
};
