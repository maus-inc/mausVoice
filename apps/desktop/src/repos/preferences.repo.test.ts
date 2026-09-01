import { describe, expect, it } from "vitest";
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
});

describe("hallucination filter default and persistence", () => {
  it("defaults hallucinationFilterEnabled to true for a fresh profile", () => {
    const prefs = createDefaultPreferences();
    expect(prefs.hallucinationFilterEnabled).toBe(true);
  });

  it("defaults an unset (null/missing) persisted value to true on load", () => {
    const local = toLocalPreferences(createDefaultPreferences());
    // Simulate a row from an older build that has no column value.
    delete (local as Record<string, unknown>).hallucinationFilterEnabled;
    const loaded = fromLocalPreferences(local);
    expect(loaded.hallucinationFilterEnabled).toBe(true);
  });

  it("preserves an explicit false across save then load", () => {
    // A user who turns the filter off must have it stay off after restart,
    // otherwise silence gating would re-enable itself.
    const prefs = {
      ...createDefaultPreferences(),
      hallucinationFilterEnabled: false,
    };
    const saved = toLocalPreferences(prefs);
    expect(saved.hallucinationFilterEnabled).toBe(false);
    const loaded = fromLocalPreferences(saved);
    expect(loaded.hallucinationFilterEnabled).toBe(false);
  });
});
