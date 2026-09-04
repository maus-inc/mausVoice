export const FEATURE_FLAGS = [
  "meetingNotesEnabled",
  "localAutomationEnabled",
  "connectorsEnabled",
  "webhooksEnabled",
  "translationsEnabled",
  "interactiveSnippetsEnabled",
  "handsFreeToggleEnabled",
  "voiceWorkflowsEnabled",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export type FeatureFlagState = Record<FeatureFlag, boolean>;
