import {
  ASSISTANT_MODE_SETTINGS_PATH,
  settingAnchorId,
  settingsPagePath,
} from "../components/settings/settings-routes";

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

/**
 * The feature switches a tip's action reads.
 *
 * A gated tip names one of these keys, so a page that resolves destinations
 * has to answer for every switch the tips declare. Adding a gate therefore
 * fails to compile until the caller subscribes to the new switch, rather than
 * reading it as off by accident.
 */
export type TipFeatures = {
  assistantModeEnabled: boolean;
};

/**
 * The switch a tip's destination sits behind, and the row that turns it on.
 *
 * `assistant-mode` is the one tip here that introduces a feature that can be
 * off, and its action opened the feature's route regardless (issue #355). With
 * assistant mode off that route has no rail entry and nothing on it works, so
 * the action leads to the setting's own row instead.
 */
type TipGate = {
  /** Which switch decides the destination. */
  feature: keyof TipFeatures;
  /** The setting's row, opened while the feature is off. */
  setupHref: string;
};

export type OnboardingTip = {
  id: OnboardingTipId;
  /** Deep link or route the tip's action opens, when there is one. */
  href?: string;
  gate?: TipGate;
};

export const ONBOARDING_TIPS: OnboardingTip[] = [
  {
    id: "generative-provider",
    href: `${settingsPagePath("ai-models")}#${settingAnchorId("ai_post_processing")}`,
  },
  { id: "writing-styles", href: "/dashboard/styling" },
  {
    id: "assistant-mode",
    href: "/dashboard/chats",
    gate: {
      feature: "assistantModeEnabled",
      setupHref: ASSISTANT_MODE_SETTINGS_PATH,
    },
  },
  { id: "review-before-insert", href: "/dashboard/transcriptions" },
  {
    id: "update-channel",
    href: `${settingsPagePath("system")}#${settingAnchorId("update_channel")}`,
  },
];

export type TipAction = {
  /** The route the action opens. */
  href: string;
  /**
   * True while the feature is off, when `href` is the row that turns it on
   * rather than the feature itself. The label follows this: "Open chat" over a
   * click that opens settings would name a page the click does not reach.
   */
  isSetup: boolean;
};

/**
 * Where a tip's action opens for the switches it reads, or null when the tip
 * has no action.
 *
 * One rule in one place. Every surface that navigates for a tip asks this,
 * so a gated tip cannot forget its switch the way the Help page's action did,
 * and a test can exercise both answers without a React tree.
 */
export const tipAction = (
  tip: OnboardingTip,
  features: TipFeatures,
): TipAction | null => {
  if (tip.gate && !features[tip.gate.feature]) {
    return { href: tip.gate.setupHref, isSetup: true };
  }
  return tip.href ? { href: tip.href, isSetup: false } : null;
};
