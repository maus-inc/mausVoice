import { getAppState } from "../store";

export const isIncognitoModeEnabled = (): boolean => {
  return getAppState().userPrefs?.incognitoModeEnabled ?? false;
};

export const isPersistenceAllowed = (): boolean => {
  return !isIncognitoModeEnabled();
};
