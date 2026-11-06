import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import {
  buildAnalyticsIdentity,
  buildFirstTouchProperties,
  buildPeopleProperties,
  buildSuperProperties,
  CURRENT_COHORT,
  type AnalyticsIdentitySources,
} from "./analytics.utils";
import { getEffectivePillVisibility } from "./user.utils";

// Behaviour lock for the analytics extraction. `original` is the inline
// derivation as it stood in AppSideEffects before the refactor, transcribed
// into focused legacy calculations; helpers must produce identical payloads for every
// combination of plan, trial, auth, and onboarding state. If a future change
// alters what we send to Mixpanel, this fails loudly rather than silently
// corrupting a funnel.
//
// The identity-source shapes are derived from the production
// `AnalyticsIdentitySources` type so this tracks the real builder contract.
// The only test-specific pieces are the legacy `currentUserId`/`prefs` field
// names (the production builder calls them `userId`/`preferences`) and the
// local auth contact.
type Inputs = Pick<AnalyticsIdentitySources, "platform" | "locale"> & {
  currentUserId: string | null;
  member: AnalyticsIdentitySources["member"];
  localUser: AnalyticsIdentitySources["localUser"];
  prefs: AnalyticsIdentitySources["preferences"];
  auth: { email?: string | null; displayName?: string | null } | null;
};

const legacyPlan = (
  member: Inputs["member"],
  currentUserId: Inputs["currentUserId"],
) => {
  const isPro = member?.plan === "pro";
  const isFree = member?.plan === "free";
  const isCommunity = !currentUserId;
  const isTrial = member?.isOnTrial ?? false;
  const isPaying = !isTrial && isPro;
  const planStatus = member?.plan ?? "community";
  return { isPro, isFree, isCommunity, isTrial, isPaying, planStatus };
};

const legacyOnboarding = (localUser: Inputs["localUser"]) => {
  const onboardedAt = localUser?.onboardedAt;
  const daysSinceOnboarded = onboardedAt
    ? dayjs().diff(dayjs(onboardedAt), "day")
    : 0;
  const onboarded = localUser?.onboarded ?? false;
  return { onboarded, onboardedAt, daysSinceOnboarded };
};

const legacyContact = (auth: Inputs["auth"]) => ({
  $email: auth?.email ?? undefined,
  $name: auth?.displayName ?? undefined,
});

const original = ({
  currentUserId,
  member,
  localUser,
  prefs,
  auth,
  platform,
  locale,
}: Inputs) => {
  const { isPro, isFree, isCommunity, isTrial, isPaying, planStatus } =
    legacyPlan(member, currentUserId);
  const { onboarded, onboardedAt, daysSinceOnboarded } =
    legacyOnboarding(localUser);
  const pillState = getEffectivePillVisibility(prefs?.dictationPillVisibility);
  return {
    firstTouch: {
      initialPlatform: platform,
      initialLocale: locale,
      initialCohort: CURRENT_COHORT,
    },
    people: {
      ...legacyContact(auth),
      planStatus,
      isPro,
      isFree,
      isCommunity,
      isTrial,
      isPaying,
      onboarded,
      onboardedAt: onboardedAt ?? undefined,
      activeSystemCohort: CURRENT_COHORT,
      daysSinceOnboarded,
      pillState,
    },
    superProps: {
      userId: currentUserId,
      planStatus,
      isPro,
      isFree,
      isCommunity,
      platform,
      locale,
      onboarded,
      daysSinceOnboarded,
      activeSystemCohort: CURRENT_COHORT,
      pillState,
    },
  };
};

const refactored = (input: Inputs) => {
  const identity = buildAnalyticsIdentity({
    userId: input.currentUserId,
    member: input.member,
    localUser: input.localUser,
    preferences: input.prefs,
    platform: input.platform,
    locale: input.locale,
  });

  return {
    firstTouch: buildFirstTouchProperties(identity),
    people: buildPeopleProperties(identity, {
      email: input.auth?.email,
      displayName: input.auth?.displayName,
    }),
    superProps: buildSuperProperties(identity),
  };
};

const plans = [undefined, null, "free", "pro"] as const;
const trials = [undefined, null, true, false] as const;
const users = [null, "user-1"] as const;
const onboardings = [
  { onboarded: undefined, onboardedAt: undefined },
  { onboarded: false, onboardedAt: null },
  { onboarded: true, onboardedAt: "2026-01-15T00:00:00.000Z" },
] as const;
const contacts = [
  null,
  { email: null, displayName: null },
  { email: "a@b.co", displayName: "Ada" },
] as const;

describe("analytics extraction is behaviour-preserving", () => {
  it("matches the original inline derivation across the full state matrix", () => {
    let cases = 0;

    for (const plan of plans) {
      for (const isOnTrial of trials) {
        for (const currentUserId of users) {
          for (const onboarding of onboardings) {
            for (const auth of contacts) {
              const input: Inputs = {
                currentUserId,
                member: { plan, isOnTrial },
                localUser: { ...onboarding },
                prefs: { dictationPillVisibility: "while_active" },
                auth,
                platform: "darwin",
                locale: "en",
              };

              expect(refactored(input)).toEqual(original(input));
              cases += 1;
            }
          }
        }
      }
    }

    // 4 plans x 4 trial states x 2 user (signed-in/out) states
    //   x 3 onboardings x 3 contacts
    expect(cases).toBe(288);
  });

  it("preserves legacy pill, platform and locale properties across supported and unknown values", () => {
    for (const visibility of [
      undefined,
      null,
      "hidden",
      "while_active",
      "persistent",
      "unknown",
    ]) {
      for (const platform of ["darwin", "win32", "linux"]) {
        for (const locale of ["en", "de", "fr"]) {
          const input: Inputs = {
            currentUserId: "user-1",
            member: { plan: "pro", isOnTrial: false },
            localUser: {
              onboarded: true,
              onboardedAt: "2026-01-15T00:00:00.000Z",
            },
            prefs: { dictationPillVisibility: visibility },
            auth: { email: "a@b.co", displayName: "Ada" },
            platform,
            locale,
          };
          expect(refactored(input)).toEqual(original(input));
        }
      }
    }
  });

  it("matches when member, user, and prefs records have not loaded yet", () => {
    const input: Inputs = {
      currentUserId: null,
      member: null,
      localUser: null,
      prefs: null,
      auth: null,
      platform: "win32",
      locale: "de",
    };

    expect(refactored(input)).toEqual(original(input));
  });
});
