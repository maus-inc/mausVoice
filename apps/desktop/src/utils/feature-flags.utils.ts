import { FEATURE_FLAGS, type FeatureFlag } from "@maus-inc/types";
import { getAppState } from "../store";

export const isValidFeatureFlag = (flag: string): flag is FeatureFlag =>
  (FEATURE_FLAGS as readonly string[]).includes(flag);

export const isFeatureEnabled = (flag: string): boolean => {
  if (!isValidFeatureFlag(flag)) {
    return false;
  }
  const state = getAppState();
  const preferences = state.userPrefs;
  if (!preferences) {
    return false;
  }
  const value = preferences[flag as keyof typeof preferences];
  return typeof value === "boolean" ? value : false;
};

export const getAllFeatureFlags = (): Record<FeatureFlag, boolean> => {
  const state = getAppState();
  const preferences = state.userPrefs;

  return FEATURE_FLAGS.reduce(
    (acc, flag) => {
      if (preferences) {
        const value = preferences[flag as keyof typeof preferences];
        acc[flag] = typeof value === "boolean" ? value : false;
      } else {
        acc[flag] = false;
      }
      return acc;
    },
    {} as Record<FeatureFlag, boolean>,
  );
};
