import type { OnboardingPageKey } from "./onboarding.state";
import type { TimingAggregate } from "../utils/pipeline-trace";

export type LocalState = {
  assistantModeEnabled: boolean;
  powerModeEnabled: boolean;
  lastDictationReminderShownAt: number | null;
  lastDictatedAt: number | null;
  lastSeenTrialExtensionClaimedAt: string | null;
  featureSeenAt: string | null;
  disablePillRewards: boolean;
  hasHiddenTrialExtensionCard: boolean;
  disableAutoStyleLoading?: boolean;
  /** Onboarding flow version last seen. Migrations never replay steps. */
  onboardingFlowVersion: number;
  /** Stable tip ids the user dismissed. Tips stay dismissible forever. */
  dismissedTipIds: string[];
  /** Device prerequisites completed outside the flow (mic, accessibility). */
  completedPrerequisites: string[];
  /** Page to resume on restart. Cleared when onboarding finishes. */
  onboardingResumePage: OnboardingPageKey | null;
  /** Per-provider pipeline timing medians, keyed by transcription mode. */
  providerTiming: Record<string, TimingAggregate>;
};

export const INITIAL_LOCAL_STATE: LocalState = {
  assistantModeEnabled: false,
  powerModeEnabled: false,
  lastDictationReminderShownAt: null,
  lastDictatedAt: null,
  lastSeenTrialExtensionClaimedAt: null,
  featureSeenAt: null,
  disablePillRewards: false,
  hasHiddenTrialExtensionCard: false,
  disableAutoStyleLoading: false,
  onboardingFlowVersion: 0,
  dismissedTipIds: [],
  completedPrerequisites: [],
  onboardingResumePage: null,
  providerTiming: {},
};
