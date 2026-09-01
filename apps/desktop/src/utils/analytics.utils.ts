import dayjs from "dayjs";
import mixpanel from "mixpanel-browser";
import type { MemberPlan } from "@maus-inc/types";
import { getEffectivePillVisibility } from "./user.utils";

export const CURRENT_COHORT = "2025-02-a";

export function getMixpanel() {
  const mixpanelToken = import.meta.env.VITE_MIXPANEL_TOKEN;
  if (!mixpanelToken) {
    // Mixpanel token is not set, do not initialize Mixpanel
    return null;
  }

  return mixpanel;
}

export function trackPageView(pageName: string) {
  getMixpanel()?.track("Page View", { page: pageName });
}

export function trackOnboardingStep(step: string) {
  getMixpanel()?.track("Onboarding Step", { step });
}

export function trackDictationStart() {
  getMixpanel()?.track("Activate Dictation Mode");
}

export function trackAgentStart() {
  getMixpanel()?.track("Activate Agent Mode");
}

export function trackPaymentComplete() {
  getMixpanel()?.track("Payment Complete");
}

export function trackButtonClick(
  name: string,
  props?: Record<string, unknown>,
) {
  getMixpanel()?.track("Button Click", { name, ...props });
}

export function trackAppUsed(appName: string) {
  getMixpanel()?.track("App Used", { appName });
}

export type AnalyticsIdentitySources = {
  userId: string | null;
  /** Member record, or null before it loads / when signed out. */
  member: {
    plan?: MemberPlan | null;
    isOnTrial?: boolean | null;
  } | null;
  /** Local user record, or null before it loads. */
  localUser: {
    onboarded?: boolean | null;
    onboardedAt?: string | null;
  } | null;
  /** User preferences, or null before they load. */
  preferences: { dictationPillVisibility?: string | null } | null;
  platform: string;
  locale: string;
};

export type AnalyticsIdentity = {
  userId: string | null;
  planStatus: string;
  isPro: boolean;
  isFree: boolean;
  isCommunity: boolean;
  isTrial: boolean;
  isPaying: boolean;
  onboarded: boolean;
  onboardedAt: string | undefined;
  daysSinceOnboarded: number;
  pillState: string;
  platform: string;
  locale: string;
  activeSystemCohort: string;
};

/**
 * Derives the Mixpanel identity payload from raw app state. Pure so the
 * plan/trial/tenure rules can be unit-tested without a Mixpanel client or a
 * mounted component.
 */
export const buildAnalyticsIdentity = (
  sources: AnalyticsIdentitySources,
): AnalyticsIdentity => {
  const { userId, member, localUser } = sources;
  const plan = member?.plan;
  const onboardedAt = localUser?.onboardedAt;
  const isPro = plan === "pro";
  const isTrial = member?.isOnTrial ?? false;

  return {
    userId,
    planStatus: plan ?? "community",
    isPro,
    isFree: plan === "free",
    isCommunity: !userId,
    isTrial,
    // A trialling pro is not yet paying us anything.
    isPaying: !isTrial && isPro,
    onboarded: localUser?.onboarded ?? false,
    onboardedAt: onboardedAt ?? undefined,
    daysSinceOnboarded: (() => {
      if (!onboardedAt) return 0;
      const parsed = dayjs(onboardedAt);
      if (!parsed.isValid()) return 0;
      const days = dayjs().diff(parsed, "day");
      return Number.isFinite(days) ? days : 0;
    })(),
    pillState: getEffectivePillVisibility(
      sources.preferences?.dictationPillVisibility,
    ),
    platform: sources.platform,
    locale: sources.locale,
    activeSystemCohort: CURRENT_COHORT,
  };
};

/** First-touch attributes, written once per identified user. */
export const buildFirstTouchProperties = (identity: AnalyticsIdentity) => ({
  initialPlatform: identity.platform,
  initialLocale: identity.locale,
  initialCohort: identity.activeSystemCohort,
});

/** Person-level profile attributes. */
export const buildPeopleProperties = (
  identity: AnalyticsIdentity,
  contact: { email?: string | null; displayName?: string | null },
) => ({
  $email: contact.email ?? undefined,
  $name: contact.displayName ?? undefined,
  planStatus: identity.planStatus,
  isPro: identity.isPro,
  isFree: identity.isFree,
  isCommunity: identity.isCommunity,
  isTrial: identity.isTrial,
  isPaying: identity.isPaying,
  onboarded: identity.onboarded,
  onboardedAt: identity.onboardedAt,
  activeSystemCohort: identity.activeSystemCohort,
  daysSinceOnboarded: identity.daysSinceOnboarded,
  pillState: identity.pillState,
});

/** Super properties attached to every subsequent event. */
export const buildSuperProperties = (identity: AnalyticsIdentity) => ({
  userId: identity.userId,
  planStatus: identity.planStatus,
  isPro: identity.isPro,
  isFree: identity.isFree,
  isCommunity: identity.isCommunity,
  platform: identity.platform,
  locale: identity.locale,
  onboarded: identity.onboarded,
  daysSinceOnboarded: identity.daysSinceOnboarded,
  activeSystemCohort: identity.activeSystemCohort,
  pillState: identity.pillState,
});
