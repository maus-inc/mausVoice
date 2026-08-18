import { describe, expect, it } from "vitest";
import {
  buildAnalyticsIdentity,
  buildFirstTouchProperties,
  buildPeopleProperties,
  buildSuperProperties,
  CURRENT_COHORT,
} from "./analytics.utils";

const sources = (
  overrides: Partial<Parameters<typeof buildAnalyticsIdentity>[0]> = {},
) => ({
  userId: "user-1",
  member: { plan: "pro" as const, isOnTrial: false },
  localUser: { onboarded: true, onboardedAt: "2026-08-01T00:00:00.000Z" },
  preferences: { dictationPillVisibility: "persistent" },
  platform: "darwin",
  locale: "en",
  ...overrides,
});

describe("buildAnalyticsIdentity", () => {
  it("treats a trialling pro as not paying", () => {
    // A trial is the one case where isPro and isPaying diverge; conflating
    // them would inflate revenue-side segments.
    const identity = buildAnalyticsIdentity(
      sources({ member: { plan: "pro", isOnTrial: true } }),
    );

    expect(identity.isPro).toBe(true);
    expect(identity.isTrial).toBe(true);
    expect(identity.isPaying).toBe(false);
  });

  it("counts a non-trial pro as paying", () => {
    const identity = buildAnalyticsIdentity(
      sources({ member: { plan: "pro", isOnTrial: false } }),
    );

    expect(identity.isPaying).toBe(true);
  });

  it("classifies a signed-out user as community, not free", () => {
    const identity = buildAnalyticsIdentity(
      sources({ userId: null, member: null }),
    );

    expect(identity.isCommunity).toBe(true);
    expect(identity.isFree).toBe(false);
    expect(identity.isPro).toBe(false);
    expect(identity.planStatus).toBe("community");
  });

  it("keeps a signed-in free user out of the community bucket", () => {
    const identity = buildAnalyticsIdentity(
      sources({ member: { plan: "free" } }),
    );

    expect(identity.isFree).toBe(true);
    expect(identity.isCommunity).toBe(false);
    expect(identity.planStatus).toBe("free");
  });

  it("defaults tenure to zero when the user never onboarded", () => {
    const identity = buildAnalyticsIdentity(
      sources({ localUser: { onboarded: false, onboardedAt: null } }),
    );

    expect(identity.onboarded).toBe(false);
    expect(identity.onboardedAt).toBeUndefined();
    expect(identity.daysSinceOnboarded).toBe(0);
  });

  it("measures tenure in whole days from the onboarding date", () => {
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const identity = buildAnalyticsIdentity(
      sources({ localUser: { onboardedAt: tenDaysAgo } }),
    );

    expect(identity.daysSinceOnboarded).toBe(10);
  });

  it("tolerates missing optional inputs without throwing", () => {
    // Member and user records load asynchronously, so the effect can run
    // before either has arrived.
    const identity = buildAnalyticsIdentity(
      sources({ member: null, localUser: null, preferences: null }),
    );

    expect(identity.planStatus).toBe("community");
    expect(identity.isTrial).toBe(false);
    expect(identity.onboarded).toBe(false);
    expect(identity.pillState).toBeTruthy();
  });
});

describe("analytics property payloads", () => {
  it("keeps first-touch attributes limited to initial-* fields", () => {
    const identity = buildAnalyticsIdentity(sources());
    const firstTouch = buildFirstTouchProperties(identity);

    // set_once payloads must never carry mutable state, or an early value
    // would be frozen against the profile forever.
    expect(Object.keys(firstTouch).sort()).toEqual([
      "initialCohort",
      "initialLocale",
      "initialPlatform",
    ]);
    expect(firstTouch.initialCohort).toBe(CURRENT_COHORT);
  });

  it("maps contact details onto Mixpanel reserved keys", () => {
    const identity = buildAnalyticsIdentity(sources());
    const people = buildPeopleProperties(identity, {
      email: "a@b.co",
      displayName: "Ada",
    });

    expect(people.$email).toBe("a@b.co");
    expect(people.$name).toBe("Ada");
  });

  it("sends undefined rather than null for absent contact details", () => {
    // null would overwrite an existing Mixpanel profile value; undefined is
    // omitted from the payload.
    const identity = buildAnalyticsIdentity(sources());
    const people = buildPeopleProperties(identity, {
      email: null,
      displayName: null,
    });

    expect(people.$email).toBeUndefined();
    expect(people.$name).toBeUndefined();
  });

  it("agrees with the people payload on every shared segment", () => {
    const identity = buildAnalyticsIdentity(
      sources({ member: { plan: "pro", isOnTrial: true } }),
    );
    const people = buildPeopleProperties(identity, {});
    const superProps = buildSuperProperties(identity);

    for (const key of [
      "planStatus",
      "isPro",
      "isFree",
      "isCommunity",
    ] as const) {
      expect(superProps[key]).toEqual(people[key]);
    }
  });
});
