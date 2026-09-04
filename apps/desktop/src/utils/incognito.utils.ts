import { getAppState } from "../store";

/**
 * Check whether incognito mode is currently enabled.
 */
export const isIncognitoModeEnabled = (): boolean => {
  return getAppState().userPrefs?.incognitoModeEnabled ?? false;
};

/**
 * Check whether data persistence is allowed (incognito mode is off).
 *
 * New persistence gates should call this helper. Existing call sites in
 * `transcribe.actions.ts` and `remote-transcript.actions.ts` still read
 * `incognitoModeEnabled` directly and should be migrated in a follow-up
 * to keep the privacy invariant centralized.
 */
export const isPersistenceAllowed = (): boolean => {
  return !isIncognitoModeEnabled();
};
