/**
 * Contextual tips for features deferred out of first run. Ids are stable:
 * dismissal and analytics key off them, so never rename one. Add the id
 * here, its copy as literals in TipCard (so extraction sees them), and a
 * TipCard anchor where the user first reaches the feature.
 */
export type OnboardingTipId =
  | "generative-provider"
  | "writing-styles"
  | "assistant-mode"
  | "review-before-insert"
  | "update-channel";

export type OnboardingTip = {
  id: OnboardingTipId;
  /** Deep link or route the tip's action opens, when there is one. */
  href?: string;
};

export const ONBOARDING_TIPS: OnboardingTip[] = [
  { id: "generative-provider", href: "/dashboard/settings" },
  { id: "writing-styles", href: "/dashboard/styling" },
  { id: "assistant-mode", href: "/dashboard/chats" },
  { id: "review-before-insert", href: "/dashboard/transcriptions" },
  { id: "update-channel", href: "/dashboard/settings" },
];
