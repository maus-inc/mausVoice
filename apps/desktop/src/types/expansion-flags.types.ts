export const EXPANSION_FLAG_NAMES = [
  "meetingNotesEnabled",
  "localApiEnabled",
  "translationsEnabled",
  "connectorsEnabled",
  "handsFreeToggleEnabled",
  "voiceWorkflowsEnabled",
] as const;

export type ExpansionFeatureName = (typeof EXPANSION_FLAG_NAMES)[number];

export type ExpansionFlags = Record<ExpansionFeatureName, boolean>;

export const DEFAULT_EXPANSION_FLAGS: ExpansionFlags = {
  meetingNotesEnabled: false,
  localApiEnabled: false,
  translationsEnabled: false,
  connectorsEnabled: false,
  handsFreeToggleEnabled: false,
  voiceWorkflowsEnabled: false,
};

/**
 * Parse a JSON string of expansion flags, falling back to defaults
 * for any missing or invalid keys.
 */
export const parseExpansionFlags = (raw?: string | null): ExpansionFlags => {
  if (!raw) {
    return { ...DEFAULT_EXPANSION_FLAGS };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const flags = { ...DEFAULT_EXPANSION_FLAGS };
    for (const name of EXPANSION_FLAG_NAMES) {
      if (typeof parsed[name] === "boolean") {
        flags[name] = parsed[name];
      }
    }
    return flags;
  } catch {
    return { ...DEFAULT_EXPANSION_FLAGS };
  }
};

/**
 * Serialize expansion flags to a JSON string for persistence.
 */
export const serializeExpansionFlags = (flags: ExpansionFlags): string => {
  return JSON.stringify(flags);
};

/**
 * Check whether a specific expansion feature flag is enabled.
 */
export const isExpansionFlagEnabled = (
  flags: ExpansionFlags,
  name: ExpansionFeatureName,
): boolean => {
  return flags[name] ?? false;
};
