import { FEATURE_FLAGS, type FeatureFlagState } from "@maus-inc/types";

export const INITIAL_FEATURE_FLAG_STATE: FeatureFlagState =
  FEATURE_FLAGS.reduce((acc, flag) => {
    acc[flag] = false;
    return acc;
  }, {} as FeatureFlagState);
