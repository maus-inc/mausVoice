import { describe, expect, it } from "vitest";
import {
  CURRENT_FEATURE_DATE,
  shouldShowFeatureReleaseDialog,
} from "./feature.utils";

// Every case is expressed relative to the cutoff, never to the wall clock. The
// original bug was a dependency on "now": `createdAt` was the current time, so
// the gate could never open. A test that reads the current date would hide that
// instead of catching it.
const cutoff = Date.parse(CURRENT_FEATURE_DATE);
const before = new Date(cutoff - 86_400_000).toISOString();
const after = new Date(cutoff + 86_400_000).toISOString();

describe("shouldShowFeatureReleaseDialog", () => {
  it("opens for a user who existed before the cutoff", () => {
    expect(
      shouldShowFeatureReleaseDialog({
        isOnboarded: true,
        userCreatedAt: before,
        featureSeenAt: null,
      }),
    ).toBe(true);
  });

  it("stays shut for a user created after the cutoff", () => {
    expect(
      shouldShowFeatureReleaseDialog({
        isOnboarded: true,
        userCreatedAt: after,
        featureSeenAt: null,
      }),
    ).toBe(false);
  });

  it("stays shut at the cutoff instant itself", () => {
    expect(
      shouldShowFeatureReleaseDialog({
        isOnboarded: true,
        userCreatedAt: CURRENT_FEATURE_DATE,
        featureSeenAt: null,
      }),
    ).toBe(false);
  });

  it("stays shut for a user who has not onboarded", () => {
    expect(
      shouldShowFeatureReleaseDialog({
        isOnboarded: false,
        userCreatedAt: before,
        featureSeenAt: null,
      }),
    ).toBe(false);
  });

  it("stays shut once the user has seen this release", () => {
    expect(
      shouldShowFeatureReleaseDialog({
        isOnboarded: true,
        userCreatedAt: before,
        featureSeenAt: CURRENT_FEATURE_DATE,
      }),
    ).toBe(false);
  });

  it("reopens only for an older feature marker", () => {
    expect(
      shouldShowFeatureReleaseDialog({
        isOnboarded: true,
        userCreatedAt: before,
        featureSeenAt: before,
      }),
    ).toBe(true);
  });

  // A space (0x20) sorts before "2" (0x32), so the old lexicographic compare
  // opened the dialog on a whitespace-only timestamp. Parsing first closes
  // every unusable value, so the outcome no longer depends on the garbage.
  it.each([undefined, null, "", " ", "not-a-date"])(
    "fails closed for an unusable createdAt (%s)",
    (userCreatedAt) => {
      expect(
        shouldShowFeatureReleaseDialog({
          isOnboarded: true,
          userCreatedAt,
          featureSeenAt: null,
        }),
      ).toBe(false);
    },
  );
});
