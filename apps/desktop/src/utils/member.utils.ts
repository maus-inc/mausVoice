import { Member, Nullable } from "@maus-inc/types";
import { getRec } from "@maus-inc/utilities";
import { getIntl } from "../i18n";
import type { AppState } from "../state/app.state";
import { EffectivePlan } from "../types/member.types";
import { isPersonalUseProEnabled } from "./personal-use.utils";

export const getMyMember = (state: AppState): Nullable<Member> => {
  return getRec(state.memberById, state.auth?.uid) ?? null;
};

export const getEffectivePlan = (state: AppState): EffectivePlan => {
  if (isPersonalUseProEnabled()) {
    return "pro";
  }
  return getMyMember(state)?.plan ?? "community";
};

export const planToDisplayName = (plan: EffectivePlan): string => {
  if (plan === "community") {
    return getIntl().formatMessage({ defaultMessage: "Community" });
  } else if (plan === "free") {
    return getIntl().formatMessage({ defaultMessage: "Free" });
  } else {
    return getIntl().formatMessage({ defaultMessage: "Pro" });
  }
};

export const getIsOnTrial = (state: AppState): boolean => {
  if (isPersonalUseProEnabled()) {
    return false;
  }
  const member = getMyMember(state);
  return member?.isOnTrial === true;
};

export const getTrialDaysRemaining = (state: AppState): number | null => {
  const member = getMyMember(state);
  if (!member?.isOnTrial || !member.trialEndsAt) {
    return null;
  }

  const now = Date.now();
  const endsAt = new Date(member.trialEndsAt).getTime();
  const msRemaining = endsAt - now;
  return Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
};
