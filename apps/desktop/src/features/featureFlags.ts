import { getAppState, produceAppState } from "../store";
import {
  DEFAULT_EXPANSION_FLAGS,
  type ExpansionFeatureName,
  type ExpansionFlags,
  parseExpansionFlags,
} from "../types/expansion-flags.types";
import { getUserPreferencesRepo } from "../repos";

/**
 * Read the current expansion flags from app state.
 */
export const getExpansionFlags = (): ExpansionFlags => {
  const raw = getAppState().userPrefs?.expansionFlags;
  return parseExpansionFlags(raw);
};

/**
 * Check whether a named expansion feature is enabled.
 */
export const isExpansionFeatureEnabled = (
  name: ExpansionFeatureName,
): boolean => {
  return getExpansionFlags()[name] ?? false;
};

/**
 * Persist a single expansion flag change atomically.
 */
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
  const updated = await repo.setExpansionFlags(JSON.stringify(flags));
  produceAppState((draft) => {
    draft.userPrefs = updated;
  });
};

export const DEFAULT_FLAGS: ExpansionFlags = DEFAULT_EXPANSION_FLAGS;
