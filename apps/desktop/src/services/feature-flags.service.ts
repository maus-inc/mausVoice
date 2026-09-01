import {
  type FeatureFlag,
  type FeatureFlagState,
  type UserPreferences,
} from "@maus-inc/types";
import { getUserPreferencesRepo } from "../repos";
import { getAppState, produceAppState } from "../store";
import { INITIAL_FEATURE_FLAG_STATE } from "../state/feature-flags.state";

export const FEATURE_FLAG_PREFERENCES_MAP: Record<
  FeatureFlag,
  keyof UserPreferences
> = {
  meetingNotesEnabled: "meetingNotesEnabled",
  localAutomationEnabled: "localAutomationEnabled",
  connectorsEnabled: "connectorsEnabled",
  webhooksEnabled: "webhooksEnabled",
  translationsEnabled: "translationsEnabled",
  interactiveSnippetsEnabled: "interactiveSnippetsEnabled",
  handsFreeToggleEnabled: "handsFreeToggleEnabled",
  voiceWorkflowsEnabled: "voiceWorkflowsEnabled",
};

export const loadFeatureFlags = async (): Promise<FeatureFlagState> => {
  const repo = getUserPreferencesRepo();
  const preferences = await repo.getUserPreferences();

  if (!preferences) {
    return { ...INITIAL_FEATURE_FLAG_STATE };
  }

  const state = { ...INITIAL_FEATURE_FLAG_STATE };
  for (const flag of Object.keys(
    FEATURE_FLAG_PREFERENCES_MAP,
  ) as FeatureFlag[]) {
    const key = FEATURE_FLAG_PREFERENCES_MAP[flag];
    const value = preferences[key];
    if (typeof value === "boolean") {
      state[flag] = value;
    }
  }
  return state;
};

export const setFeatureFlag = async (
  flag: FeatureFlag,
  enabled: boolean,
): Promise<void> => {
  const state = getAppState();
  const preferences = state.userPrefs;

  if (!preferences) {
    return;
  }

  const updated: UserPreferences = {
    ...preferences,
    [FEATURE_FLAG_PREFERENCES_MAP[flag]]: enabled,
  };

  produceAppState((draft) => {
    draft.userPrefs = updated;
  });

  try {
    const repo = getUserPreferencesRepo();
    await repo.setUserPreferences(updated);
  } catch {
    produceAppState((draft) => {
      draft.userPrefs = preferences;
    });
  }
};

export const isFeatureFlagEnabled = (flag: string): boolean => {
  const state = getAppState();
  if (!state.userPrefs) {
    return false;
  }
  const key = flag as FeatureFlag;
  const preferenceKey = FEATURE_FLAG_PREFERENCES_MAP[key];
  if (!preferenceKey) {
    return false;
  }
  const value = state.userPrefs[preferenceKey];
  return typeof value === "boolean" ? value : false;
};
