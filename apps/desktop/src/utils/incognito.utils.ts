import { getAppState } from "../store";

/**
 * Check whether incognito mode is currently enabled.
 */
export const isIncognitoModeEnabled = (): boolean => {
  return getAppState().userPrefs?.incognitoModeEnabled ?? false;
};

/**
 * Check whether data persistence is allowed (incognito mode is off).
 */
export const isPersistenceAllowed = (): boolean => {
  return !isIncognitoModeEnabled();
};
