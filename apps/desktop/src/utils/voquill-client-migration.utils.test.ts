// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  collectPendingLegacyModeFlagUpdates,
  LEGACY_ASSISTANT_MODE_ENABLED_KEY,
  LEGACY_POWER_MODE_ENABLED_KEY,
  migrateLegacyVoquillClientStorage,
  sanitizeLegacyPersistedLocalState,
} from "./voquill-client-migration.utils";

describe("voquill-client-migration.utils", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sanitizes valid voquill-local-state fields, forces ephemeralSessionActive false, and drops unknown keys", () => {
    const sanitized = sanitizeLegacyPersistedLocalState(
      JSON.stringify({
        state: {
          local: {
            onboardingFlowVersion: 2,
            onboardingResumePage: "micPerms",
            dismissedTipIds: ["tip-a", "tip-b"],
            disableAutoStyleLoading: true,
            assistantModeEnabled: true,
            ephemeralSessionActive: true,
            unknownEvilField: "should-be-dropped",
          },
        },
        version: 0,
      }),
    );

    expect(sanitized).not.toBeNull();
    const parsed = JSON.parse(sanitized!) as {
      state: { local: Record<string, unknown> };
    };
    expect(parsed.state.local.onboardingFlowVersion).toBe(2);
    expect(parsed.state.local.onboardingResumePage).toBe("micPerms");
    expect(parsed.state.local.dismissedTipIds).toEqual(["tip-a", "tip-b"]);
    expect(parsed.state.local.disableAutoStyleLoading).toBe(true);
    expect(parsed.state.local.assistantModeEnabled).toBe(true);
    expect(parsed.state.local.ephemeralSessionActive).toBe(false);
    expect(parsed.state.local).not.toHaveProperty("unknownEvilField");
  });

  it("drops invalid onboardingResumePage values so defaults apply", () => {
    const sanitized = sanitizeLegacyPersistedLocalState(
      JSON.stringify({
        state: {
          local: {
            onboardingResumePage: "removedLegacyStep",
          },
        },
        version: 0,
      }),
    );

    expect(sanitized).not.toBeNull();
    const parsed = JSON.parse(sanitized!) as {
      state: { local: Record<string, unknown> };
    };
    expect(parsed.state.local).not.toHaveProperty("onboardingResumePage");
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(sanitizeLegacyPersistedLocalState("{broken json")).toBeNull();
    expect(sanitizeLegacyPersistedLocalState("[]")).toBeNull();
  });

  it("migrates local state, checklist booleans, and theme mode non-destructively and idempotently", () => {
    window.localStorage.setItem(
      "voquill-local-state",
      JSON.stringify({
        state: { local: { disableAutoStyleLoading: true } },
        version: 0,
      }),
    );
    window.localStorage.setItem("voquill:checklist-dismissed", "true");
    window.localStorage.setItem("voquill:checklist-dictionary", "true");
    window.localStorage.setItem("mode", "dark");

    const first = migrateLegacyVoquillClientStorage(window.localStorage);
    expect(first.migratedKeys).toEqual(
      expect.arrayContaining([
        "mausvoice-local-state",
        "mausvoice:checklist-dismissed",
        "mausvoice:checklist-dictionary",
        "mui-mode",
      ]),
    );
    expect(first.invalidKeys).toEqual([]);

    expect(window.localStorage.getItem("mausvoice:checklist-dismissed")).toBe(
      "true",
    );
    expect(window.localStorage.getItem("mausvoice:checklist-dictionary")).toBe(
      "true",
    );
    expect(window.localStorage.getItem("mui-mode")).toBe("dark");
    // Legacy keys are preserved intact.
    expect(window.localStorage.getItem("voquill-local-state")).not.toBeNull();
    expect(window.localStorage.getItem("mode")).toBe("dark");

    // Second run skips everything already present and never overwrites.
    const second = migrateLegacyVoquillClientStorage(window.localStorage);
    expect(second.migratedKeys).toEqual([]);
    expect(second.skippedKeys).toEqual(
      expect.arrayContaining([
        "mausvoice-local-state",
        "mausvoice:checklist-dismissed",
        "mausvoice:checklist-dictionary",
        "mui-mode",
      ]),
    );
  });

  it("never overwrites existing mausvoice-local-state or mui-mode and rejects invalid values", () => {
    window.localStorage.setItem(
      "mausvoice-local-state",
      JSON.stringify({
        state: { local: { disableAutoStyleLoading: false } },
        version: 0,
      }),
    );
    window.localStorage.setItem(
      "voquill-local-state",
      JSON.stringify({
        state: { local: { disableAutoStyleLoading: true } },
        version: 0,
      }),
    );
    window.localStorage.setItem("mode", "neon-purple");
    window.localStorage.setItem(
      "voquill:checklist-writing-style",
      "not-a-bool",
    );

    const result = migrateLegacyVoquillClientStorage(window.localStorage);
    expect(result.skippedKeys).toContain("mausvoice-local-state");
    expect(result.invalidKeys).toEqual(
      expect.arrayContaining(["mode", "voquill:checklist-writing-style"]),
    );
    expect(window.localStorage.getItem("mui-mode")).toBeNull();
    const preserved = JSON.parse(
      window.localStorage.getItem("mausvoice-local-state")!,
    ) as { state: { local: { disableAutoStyleLoading: boolean } } };
    expect(preserved.state.local.disableAutoStyleLoading).toBe(false);
  });

  it("collects only validated legacy assistant/power mode flags strictly", () => {
    expect(collectPendingLegacyModeFlagUpdates(window.localStorage)).toEqual(
      {},
    );

    window.localStorage.setItem(LEGACY_ASSISTANT_MODE_ENABLED_KEY, "true");
    window.localStorage.setItem(LEGACY_POWER_MODE_ENABLED_KEY, "invalid");

    expect(collectPendingLegacyModeFlagUpdates(window.localStorage)).toEqual({
      assistantModeEnabled: true,
    });
  });

  it("migrates valid TimingAggregate providerTiming entries and rejects malformed shapes", () => {
    window.localStorage.setItem(
      "voquill-local-state",
      JSON.stringify({
        state: {
          local: {
            providerTiming: {
              openai: { samples: 2, stages: { transcribe: [110, 130] } },
            },
          },
        },
        version: 0,
      }),
    );

    const result = migrateLegacyVoquillClientStorage(window.localStorage);
    expect(result.migratedKeys).toContain("mausvoice-local-state");
    const migrated = JSON.parse(
      window.localStorage.getItem("mausvoice-local-state")!,
    ) as {
      state: {
        local: {
          providerTiming: Record<
            string,
            { samples: number; stages: Record<string, number[]> }
          >;
        };
      };
    };
    expect(migrated.state.local.providerTiming).toEqual({
      openai: { samples: 2, stages: { transcribe: [110, 130] } },
    });

    window.localStorage.clear();
    window.localStorage.setItem(
      "voquill-local-state",
      JSON.stringify({
        state: {
          local: {
            providerTiming: {
              openai: { count: 2, medianMs: 120 },
            },
          },
        },
        version: 0,
      }),
    );

    const invalidResult = migrateLegacyVoquillClientStorage(
      window.localStorage,
    );
    expect(invalidResult.migratedKeys).toContain("mausvoice-local-state");
    const sanitized = JSON.parse(
      window.localStorage.getItem("mausvoice-local-state")!,
    ) as { state: { local: Record<string, unknown> } };
    expect(sanitized.state.local.providerTiming).toBeUndefined();
  });
});
