import type { UserPreferences } from "@maus-inc/types";
import { describe, expect, it } from "vitest";
import {
  captureExpansionFlags,
  getExpansionFlagsRevision,
  markExpansionFlagsChanged,
  preserveNewerExpansionFlags,
} from "./expansion-flags-revision";

const preferences = (expansionFlags: string | undefined): UserPreferences =>
  ({ expansionFlags }) as unknown as UserPreferences;

describe("captureExpansionFlags", () => {
  it("records the flags and the revision they were captured at", () => {
    const snapshot = captureExpansionFlags(preferences("{}"));

    expect(snapshot.flags).toBe("{}");
    expect(snapshot.revision).toBe(getExpansionFlagsRevision());
  });

  it("records undefined flags for a user without preferences", () => {
    expect(captureExpansionFlags(null).flags).toBeUndefined();
  });
});

describe("preserveNewerExpansionFlags", () => {
  it("takes the saved row when nothing changed locally", () => {
    const snapshot = captureExpansionFlags(preferences("{}"));
    const saved = preferences('{"a":true}');

    expect(
      preserveNewerExpansionFlags(saved, preferences("{}"), snapshot),
    ).toBe(saved);
  });

  it("keeps a local edit made while the save was in flight", () => {
    const snapshot = captureExpansionFlags(preferences("{}"));
    const saved = preferences("{}");
    const local = preferences('{"a":true}');

    expect(preserveNewerExpansionFlags(saved, local, snapshot)).toEqual({
      expansionFlags: '{"a":true}',
    });
  });

  it("keeps the local value when a flag changed and changed back", () => {
    // The value matches the snapshot but the revision moved, which is the
    // whole reason this module tracks a revision instead of comparing strings.
    const snapshot = captureExpansionFlags(preferences("{}"));
    markExpansionFlagsChanged();
    const saved = preferences('{"other":true}');

    expect(
      preserveNewerExpansionFlags(saved, preferences("{}"), snapshot),
    ).toEqual({ expansionFlags: "{}" });
  });

  it("takes the saved row when the current preferences are gone", () => {
    const snapshot = captureExpansionFlags(preferences("{}"));
    const saved = preferences('{"a":true}');

    expect(preserveNewerExpansionFlags(saved, null, snapshot)).toBe(saved);
  });

  it("takes the saved row when the current row has no flags recorded", () => {
    const snapshot = captureExpansionFlags(preferences("{}"));
    const saved = preferences('{"a":true}');

    expect(
      preserveNewerExpansionFlags(saved, preferences(undefined), snapshot),
    ).toBe(saved);
  });
});
