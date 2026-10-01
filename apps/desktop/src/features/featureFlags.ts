import { getAppState, produceAppState } from "../store";
import { getLogger } from "../utils/log.utils";
import {
  DEFAULT_EXPANSION_FLAGS,
  type ExpansionFeatureName,
  type ExpansionFlags,
  parseExpansionFlags,
  serializeExpansionFlags,
} from "../types/expansion-flags.types";
import { getUserPreferencesRepo } from "../repos";
import {
  endEphemeralSession,
  startEphemeralSession,
} from "../actions/ephemeral-session.actions";

let togglePromise: Promise<void> = Promise.resolve();

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
 * Persist a single expansion flag change.
 * Toggles in this window are serialized to prevent lost updates.
 * A native compare-and-set protects updates from other windows.
 */
export const setExpansionFlag = (
  name: ExpansionFeatureName,
  enabled: boolean,
): Promise<void> => {
  const currentToggle = togglePromise.then(async () => {
    try {
      const repo = getUserPreferencesRepo();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await repo.getUserPreferences();
        if (!current) return;
        const expected = current.expansionFlags ?? "{}";
        const flags = parseExpansionFlags(expected);
        flags[name] = enabled;
        const updated = await repo.compareAndSetExpansionFlags(
          expected,
          serializeExpansionFlags(flags),
        );
        if (!updated) continue;
        produceAppState((draft) => {
          draft.userPrefs = updated;
        });
        // The flag is the only writer of `ephemeralSessionActive`, so the run
        // has to start and stop here or the preference and the session it
        // offers disagree: persistence would stay on for a session the user
        // turned on. Only after the compare-and-set succeeded -- a rejected
        // update must not leave a session running behind a flag that says it is
        // off.
        if (name === "ephemeralSessionEnabled") {
          await (enabled ? startEphemeralSession() : endEphemeralSession());
        }
        return;
      }
      throw new Error("Expansion flags changed repeatedly; retry the update");
    } catch (error) {
      getLogger().error("Failed to set expansion flag");
      throw error;
    }
  });

  // Ensure the shared chain recovers from failures so later toggles
  // remain runnable, while still returning the original promise so
  // callers can observe success or rejection.
  togglePromise = currentToggle.catch(() => undefined);

  return currentToggle;
};

export const DEFAULT_FLAGS: ExpansionFlags = { ...DEFAULT_EXPANSION_FLAGS };
