import { describe, expect, it } from "vitest";
import {
  createPreviewScenario,
  scenarioForPath,
  type PreviewScenarioId,
} from "./scenarios";
import { CURRENT_FEATURE_DATE } from "../utils/feature.utils";
import { LOCAL_USER_ID } from "../utils/user.utils";

const workspaceScenarios: PreviewScenarioId[] = [
  "populated",
  "empty",
  "permission-denied",
  "voquill-migration",
];

describe("browser preview scenarios", () => {
  it.each(workspaceScenarios)(
    "creates a deterministic onboarded %s workspace",
    (scenario) => {
      const snapshot = createPreviewScenario(scenario);

      expect(snapshot.state.initialized).toBe(true);
      expect(snapshot.state.auth?.email).toBe("preview@mausvoice.local");
      expect(snapshot.data.user?.onboarded).toBe(true);
      expect(snapshot.state.local.featureSeenAt).toBe(CURRENT_FEATURE_DATE);
      expect(snapshot.state.settings.elevationStartupPending).toBe(false);
      expect(snapshot.data.preferences?.userId).toBe(LOCAL_USER_ID);
    },
  );

  it("seeds a representative workspace without any credential material", () => {
    const snapshot = createPreviewScenario("populated");

    expect(snapshot.data.transcriptions).toHaveLength(3);
    expect(snapshot.data.dailyActivity.length).toBeGreaterThan(0);
    expect(snapshot.data.terms).toHaveLength(3);
    expect(snapshot.data.conversations).toHaveLength(2);
    expect(snapshot.data.apiKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OpenAI workspace key",
          keyFull: null,
        }),
      ]),
    );
    expect(snapshot.state.transcriptions.transcriptionIds).toEqual([
      "transcription-brief",
      "transcription-status",
      "transcription-email",
    ]);
    expect(snapshot.state.settings.apiKeysStatus).toBe("success");
    expect(snapshot.state.settings.apiKeys).toHaveLength(1);
  });

  it("seeds app paste bindings using the values accepted by the settings selector", () => {
    const targets = createPreviewScenario("populated").data.appTargets;
    expect(targets.some((target) => target.pasteKeybind === "ctrl+v")).toBe(
      true,
    );
    for (const target of targets) {
      expect([null, "shift+insert", "ctrl+v", "ctrl+shift+v"]).toContain(
        target.pasteKeybind,
      );
    }
  });

  it("reuses populated data without sharing mutable values across scenarios", () => {
    const populated = createPreviewScenario("populated");
    const permissionDenied = createPreviewScenario("permission-denied");

    expect(permissionDenied.data).toEqual(populated.data);
    expect(permissionDenied.data.transcriptions).not.toBe(
      populated.data.transcriptions,
    );
    expect(permissionDenied.data.transcriptions[0]).not.toBe(
      populated.data.transcriptions[0],
    );
    expect(permissionDenied.data.dailyActivity).not.toBe(
      populated.data.dailyActivity,
    );
  });

  it("exposes an explicit denied-permission workspace", () => {
    const snapshot = createPreviewScenario("permission-denied");

    expect(snapshot.state.permissions.microphone?.state).toBe("denied");
    expect(snapshot.state.permissions.accessibility?.state).toBe("denied");
  });

  it("models listener health after the permission each scenario reports", () => {
    // A hook cannot install without accessibility, so the denied scenario must
    // not seed the healthy state a granted machine reports.
    expect(
      createPreviewScenario("permission-denied").state.keyboardListenerHealth,
    ).toBe("grab_failed");
    expect(
      createPreviewScenario("populated").state.keyboardListenerHealth,
    ).toBe("healthy_grab");
  });

  it("exposes an explicit Voquill migration workspace with keys needing re-entry", () => {
    const snapshot = createPreviewScenario("voquill-migration");

    expect(snapshot.state.voquillMigration.status).toBe("success");
    expect(snapshot.state.voquillMigration.report?.status).toBe("completed");
    expect(snapshot.state.voquillMigration.report?.legacyDetected).toBe(true);
    expect(snapshot.state.voquillMigration.report?.actionItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "reenter_api_keys",
          count: 2,
        }),
      ]),
    );
    expect(
      snapshot.data.apiKeys.filter(
        (key) => key.credentialStatus === "needs_reentry",
      ),
    ).toHaveLength(2);
    expect(snapshot.data.apiKeys.every((key) => key.keyFull === null)).toBe(
      true,
    );
  });

  it("keeps the empty workspace free of history and content", () => {
    const snapshot = createPreviewScenario("empty");

    expect(snapshot.data.transcriptions).toEqual([]);
    expect(snapshot.data.dailyActivity).toEqual([]);
    expect(snapshot.data.terms).toEqual([]);
    expect(snapshot.data.conversations).toEqual([]);
    expect(snapshot.state.transcriptions.transcriptionIds).toEqual([]);
  });

  it("models welcome and onboarding before dashboard access", () => {
    const welcome = createPreviewScenario("welcome");
    const onboarding = createPreviewScenario("onboarding");

    expect(welcome.state.initialized).toBe(false);
    expect(welcome.state.auth).toBeNull();
    expect(onboarding.state.auth?.email).toBe("preview@mausvoice.local");
    expect(onboarding.data.user?.onboarded).toBe(false);
    expect(onboarding.state.onboarding.currentPage).toBe("signIn");
  });

  it("selects a useful scenario for direct first-run links", () => {
    expect(scenarioForPath("/dashboard")).toBe("populated");
    expect(scenarioForPath("/welcome")).toBe("welcome");
    expect(scenarioForPath("/login")).toBe("welcome");
    expect(scenarioForPath("/onboarding")).toBe("onboarding");
  });
});
