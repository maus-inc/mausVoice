import { getAppState, produceAppState } from "../store";
import {
  DEFAULT_EXPANSION_FLAGS,
  type ExpansionFeatureName,
  type ExpansionFlags,
  parseExpansionFlags,
} from "../types/expansion-flags.types";
import { getUserPreferencesRepo } from "../repos";

export const getExpansionFlags = (): ExpansionFlags => {
  const raw = getAppState().userPrefs?.expansionFlags;
  return parseExpansionFlags(raw);
};

export const isExpansionFeatureEnabled = (
  name: ExpansionFeatureName,
): boolean => {
  return getExpansionFlags()[name] ?? false;
};

export const setExpansionFlag = async (
  name: ExpansionFeatureName,
  enabled: boolean,
): Promise<void> => {
  const repo = getUserPreferencesRepo();
  const current = await repo.getUserPreferences();
  if (!current) {
    return;
  }
  const flags = parseExpansionFlags(current.expansionFlags);
  flags[name] = enabled;
  const updated = await repo.setUserPreferences({
    ...current,
    expansionFlags: JSON.stringify(flags),
  });
  produceAppState((draft) => {
    draft.userPrefs = updated;
  });
};

export const DEFAULT_FLAGS: ExpansionFlags = DEFAULT_EXPANSION_FLAGS;
