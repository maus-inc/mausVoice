import { describe, expect, it } from "vitest";
import type { Nullable, PillPlacement } from "@maus-inc/types";
import { createDefaultPreferences } from "../actions/user.actions";
import { fromLocalPreferences, toLocalPreferences } from "./preferences.repo";

const localPrefsWithActiveLanguage = (
  activeDictationLanguage: string | null,
) => ({
  ...toLocalPreferences(createDefaultPreferences()),
  activeDictationLanguage,
});

describe("legacy AI mode normalization", () => {
  it("maps the removed cloud transcription mode to local", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
      transcriptionMode: "cloud",
    });
    expect(loaded.transcriptionMode).toBe("local");
  });

  it("maps the removed cloud agent mode to none", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
      agentMode: "cloud",
    });
    expect(loaded.agentMode).toBe("none");
  });

  it("maps the removed cloud post-processing mode to none", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
      postProcessingMode: "cloud",
    });
    expect(loaded.postProcessingMode).toBe("none");
  });

  it("keeps valid modes and unset modes untouched", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
      transcriptionMode: "api",
      postProcessingMode: null,
      agentMode: "openclaw",
    });
    expect(loaded.transcriptionMode).toBe("api");
    expect(loaded.postProcessingMode).toBeNull();
    expect(loaded.agentMode).toBe("openclaw");
  });
});

describe("preferences round-trip", () => {
  it("preserves a non-primary active dictation language across load then save", () => {
    const loaded = fromLocalPreferences(localPrefsWithActiveLanguage("es"));
    expect(loaded.activeDictationLanguage).toBe("es");

    const saved = toLocalPreferences(loaded);
    expect(saved.activeDictationLanguage).toBe("es");
  });

  it("does not reset the active dictation language on an unrelated preference change", () => {
    const loaded = fromLocalPreferences(localPrefsWithActiveLanguage("es"));
    loaded.preferredMicrophone = "USB Microphone";

    const saved = toLocalPreferences(loaded);
    expect(saved.activeDictationLanguage).toBe("es");
    expect(saved.preferredMicrophone).toBe("USB Microphone");
  });

  it("writes the primary sentinel when no active dictation language is set", () => {
    const loaded = fromLocalPreferences(localPrefsWithActiveLanguage(null));
    expect(loaded.activeDictationLanguage).toBeNull();

    const saved = toLocalPreferences(loaded);
    expect(saved.activeDictationLanguage).toBe("primary");
  });

  it("round-trips a fully-populated UserPreferences", () => {
    const populated = {
      ...createDefaultPreferences(),
      transcriptionMode: "api" as const,
      transcriptionApiKeyId: "transcription-key",
      transcriptionDevice: "default-microphone",
      transcriptionModelSize: "large-v3",
      postProcessingMode: "api" as const,
      postProcessingApiKeyId: "pp-key",
      postProcessingOllamaUrl: "http://localhost:11434",
      postProcessingOllamaModel: "llama3.1",
      activeToneId: "tone-1",
      gotStartedAt: 1700000000000,
      gpuEnumerationEnabled: true,
      agentMode: "api" as const,
      agentModeApiKeyId: "agent-key",
      openclawGatewayUrl: "https://gateway.example.com",
      openclawToken: "openclaw-token",
      lastSeenFeature: "feature-x",
      activeDictationLanguage: "fr",
      preferredMicrophone: "Yeti X",
      ignoreUpdateDialog: true,
      incognitoModeEnabled: true,
      incognitoModeIncludeInStats: true,
      preserveAudioOnFailure: false,
      dictationLimitMinutes: 15,
      dictationPillVisibility: "persistent" as const,
      realtimeOutputEnabled: true,
      remoteOutputEnabled: true,
      remoteTargetDeviceId: "device-1",
      remoteReceiverPort: 9000,
      remoteReceiverAutoStart: true,
      dictationAudioDim: 0.5,
      pasteKeybind: "Ctrl+Shift+V",
      menuBarIconHidden: true,
      insertionMethod: "keystroke",
      typingSpeedMs: 25,
      pillResetMonitorStrategy: "cursor" as const,
      pillPlacement: "top" as const,
      alwaysRequestAdminOnStartup: true,
      handsFreeDelayMs: 2500,
    };

    const local = toLocalPreferences(populated);
    const reloaded = fromLocalPreferences(local);
    expect(reloaded).toEqual(populated);
  });
});

describe("autoLearnDictionaryEnabled preference", () => {
  it("defaults to true when the local row omits the field", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
      autoLearnDictionaryEnabled: undefined,
    });
    expect(loaded.autoLearnDictionaryEnabled).toBe(true);
  });

  it("preserves an explicit false across a round-trip", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
      autoLearnDictionaryEnabled: false,
    });
    expect(loaded.autoLearnDictionaryEnabled).toBe(false);

    const saved = toLocalPreferences(loaded);
    expect(saved.autoLearnDictionaryEnabled).toBe(false);
  });
});

describe("preserveAudioOnFailure preference", () => {
  it("defaults to true when the local row omits the field", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
    });
    expect(loaded.preserveAudioOnFailure).toBe(true);
  });

  it("preserves an explicit false across a round-trip", () => {
    const base = toLocalPreferences(createDefaultPreferences());
    const loaded = fromLocalPreferences({
      ...base,
      preserveAudioOnFailure: false,
    });
    expect(loaded.preserveAudioOnFailure).toBe(false);

    const saved = toLocalPreferences(loaded);
    expect(saved.preserveAudioOnFailure).toBe(false);
  });
});

describe("pillPlacement preference", () => {
  it("defaults to bottom when the local row omits the field", () => {
    const loaded = fromLocalPreferences({
      ...toLocalPreferences(createDefaultPreferences()),
    });
    expect(loaded.pillPlacement).toBe("bottom");
  });

  it("preserves a top placement across a round-trip", () => {
    const base = toLocalPreferences(createDefaultPreferences());
    const loaded = fromLocalPreferences({ ...base, pillPlacement: "top" });
    expect(loaded.pillPlacement).toBe("top");

    const saved = toLocalPreferences(loaded);
    expect(saved.pillPlacement).toBe("top");
  });

  it("normalises an unknown placement to bottom", () => {
    const base = toLocalPreferences(createDefaultPreferences());
    const loaded = fromLocalPreferences({
      ...base,
      pillPlacement: "side" as unknown as Nullable<PillPlacement>,
    });
    expect(loaded.pillPlacement).toBe("bottom");
  });
});
