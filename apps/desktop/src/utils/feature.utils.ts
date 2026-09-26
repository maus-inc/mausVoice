import { StylingMode } from "@maus-inc/types";
import { AppState } from "../state/app.state";
import { getMyUser } from "./user.utils";

export const CURRENT_FEATURE_DATE = new Date("2026-08-15").toISOString();

const FEATURE_CUTOFF_MS = Date.parse(CURRENT_FEATURE_DATE);

/**
 * Numeric, not lexicographic. A lexicographic compare of two ISO-8601 strings
 * happens to work, which is exactly why the bug hid: `createdAt` was the
 * current time, so it compared greater than the cutoff on every open. Parsing
 * to milliseconds also means a corrupt timestamp fails closed instead of
 * sorting into a random side of the comparison.
 */
const isBeforeFeatureDate = (value: string | null | undefined): boolean => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) && parsed < FEATURE_CUTOFF_MS;
};

export type FeatureReleaseDialogGate = {
  isOnboarded: boolean;
  userCreatedAt: string | null | undefined;
  featureSeenAt: string | null | undefined;
};

/**
 * The single source of truth for whether the release dialog opens. Extracted
 * from the component so the rule is unit-testable and cannot drift between the
 * three inputs the dialog combines.
 */
export const shouldShowFeatureReleaseDialog = ({
  isOnboarded,
  userCreatedAt,
  featureSeenAt,
}: FeatureReleaseDialogGate): boolean => {
  if (!isOnboarded) {
    return false;
  }
  if (!isBeforeFeatureDate(userCreatedAt)) {
    return false;
  }
  return featureSeenAt == null || isBeforeFeatureDate(featureSeenAt);
};

export const getEffectiveStylingMode = (state: AppState): StylingMode => {
  const user = getMyUser(state);
  return user?.stylingMode ?? "app";
};
