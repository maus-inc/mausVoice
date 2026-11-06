import type { UserPreferences } from "@maus-inc/types";

// Tracks flag changes applied in this webview, including changes that return to
// their earlier value while an unrelated whole-row save is awaiting its reply.
let revision = 0;

export const getExpansionFlagsRevision = (): number => revision;
export const markExpansionFlagsChanged = (): void => {
  revision += 1;
};

export const captureExpansionFlags = (preferences: UserPreferences | null) => ({
  flags: preferences?.expansionFlags,
  revision,
});

/** Keep newer locally published flags when a whole-row save replies late. */
export const preserveNewerExpansionFlags = (
  saved: UserPreferences,
  current: UserPreferences | null,
  snapshot: ReturnType<typeof captureExpansionFlags>,
): UserPreferences => {
  const flags = current?.expansionFlags;
  return flags !== undefined &&
    (flags !== snapshot.flags || revision !== snapshot.revision)
    ? { ...saved, expansionFlags: flags }
    : saved;
};
