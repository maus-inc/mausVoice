export type ExpansionFeatureName =
  | "meetingNotesEnabled"
  | "localApiEnabled"
  | "translationsEnabled"
  | "connectorsEnabled"
  | "handsFreeToggleEnabled"
  | "voiceWorkflowsEnabled";

export type ExpansionFlags = Record<ExpansionFeatureName, boolean>;

export const DEFAULT_EXPANSION_FLAGS: ExpansionFlags = {
  meetingNotesEnabled: false,
  localApiEnabled: false,
  translationsEnabled: false,
  connectorsEnabled: false,
  handsFreeToggleEnabled: false,
  voiceWorkflowsEnabled: false,
};

export const EXPANSION_FLAG_NAMES: ExpansionFeatureName[] = [
  "meetingNotesEnabled",
  "localApiEnabled",
  "translationsEnabled",
  "connectorsEnabled",
  "handsFreeToggleEnabled",
  "voiceWorkflowsEnabled",
];

export const parseExpansionFlags = (
  raw?: string | null,
): ExpansionFlags => {
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

export const serializeExpansionFlags = (flags: ExpansionFlags): string => {
  return JSON.stringify(flags);
};

export const isExpansionFlagEnabled = (
  flags: ExpansionFlags,
  name: ExpansionFeatureName,
): boolean => {
  return flags[name] ?? false;
};
