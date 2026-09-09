import { describe, expect, it } from "vitest";
import {
  createPreviewScenario,
  scenarioForPath,
  type PreviewScenarioId,
} from "./scenarios";
import { LOCAL_USER_ID } from "../utils/user.utils";

const workspaceScenarios: PreviewScenarioId[] = [
  "populated",
  "empty",
  "permission-denied",
];

describe("browser preview scenarios", () => {
  it.each(workspaceScenarios)(
    "creates a deterministic onboarded %s workspace",
    (scenario) => {
      const snapshot = createPreviewScenario(scenario);

      expect(snapshot.state.initialized).toBe(true);
      expect(snapshot.state.auth?.email).toBe("preview@mausvoice.local");
      expect(snapshot.data.user?.onboarded).toBe(true);
      expect(snapshot.state.settings.elevationStartupPending).toBe(false);
      expect(snapshot.data.preferences?.userId).toBe(LOCAL_USER_ID);
    },
  );

  it("seeds a representative workspace without any credential material", () => {
    const snapshot = createPreviewScenario("populated");

    expect(snapshot.data.transcriptions).toHaveLength(3);
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

  it("exposes an explicit denied-permission workspace", () => {
    const snapshot = createPreviewScenario("permission-denied");

    expect(snapshot.state.permissions.microphone?.state).toBe("denied");
    expect(snapshot.state.permissions.accessibility?.state).toBe("denied");
  });

  it("keeps the empty workspace free of history and content", () => {
    const snapshot = createPreviewScenario("empty");

    expect(snapshot.data.transcriptions).toEqual([]);
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
