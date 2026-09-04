import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultPreferences } from "../actions/user.actions";
import {
  isFeatureFlagEnabled,
  loadFeatureFlags,
  setFeatureFlag,
} from "./feature-flags.service";
import { getAppState, produceAppState } from "../store";

const getUserPreferencesRepo = vi.fn();
const setUserPreferences = vi.fn();

vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => ({
    getUserPreferences: getUserPreferencesRepo,
    setUserPreferences,
  }),
}));

describe("feature-flags.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    produceAppState((draft) => {
      draft.userPrefs = null;
    });
  });

  describe("loadFeatureFlags", () => {
    it("returns all flags false when no preferences exist", async () => {
      getUserPreferencesRepo.mockResolvedValue(null);
      const result = await loadFeatureFlags();
      expect(result.meetingNotesEnabled).toBe(false);
      expect(result.connectorsEnabled).toBe(false);
      expect(result.voiceWorkflowsEnabled).toBe(false);
    });

    it("returns all flags false when preferences have defaults", async () => {
      getUserPreferencesRepo.mockResolvedValue(createDefaultPreferences());
      const result = await loadFeatureFlags();
      expect(result.meetingNotesEnabled).toBe(false);
      expect(result.localAutomationEnabled).toBe(false);
      expect(result.connectorsEnabled).toBe(false);
      expect(result.webhooksEnabled).toBe(false);
      expect(result.translationsEnabled).toBe(false);
      expect(result.interactiveSnippetsEnabled).toBe(false);
      expect(result.handsFreeToggleEnabled).toBe(false);
      expect(result.voiceWorkflowsEnabled).toBe(false);
    });

    it("reads enabled flags from preferences", async () => {
      const prefs = createDefaultPreferences();
      prefs.meetingNotesEnabled = true;
      prefs.connectorsEnabled = true;
      getUserPreferencesRepo.mockResolvedValue(prefs);

      const result = await loadFeatureFlags();
      expect(result.meetingNotesEnabled).toBe(true);
      expect(result.connectorsEnabled).toBe(true);
      expect(result.webhooksEnabled).toBe(false);
    });
  });

  describe("setFeatureFlag", () => {
    it("updates state and persists the flag", async () => {
      const prefs = createDefaultPreferences();
      produceAppState((draft) => {
        draft.userPrefs = prefs;
      });
      setUserPreferences.mockResolvedValue({
        ...prefs,
        meetingNotesEnabled: true,
      });

      await setFeatureFlag("meetingNotesEnabled", true);

      const state = getAppState();
      expect(state.userPrefs?.meetingNotesEnabled).toBe(true);
      expect(setUserPreferences).toHaveBeenCalled();
    });

    it("rolls back state on persistence failure", async () => {
      const prefs = createDefaultPreferences();
      produceAppState((draft) => {
        draft.userPrefs = prefs;
      });
      setUserPreferences.mockRejectedValue(new Error("DB error"));

      await setFeatureFlag("meetingNotesEnabled", true);

      const state = getAppState();
      expect(state.userPrefs?.meetingNotesEnabled).toBe(false);
    });

    it("does nothing when userPrefs is null", async () => {
      produceAppState((draft) => {
        draft.userPrefs = null;
      });
      await setFeatureFlag("meetingNotesEnabled", true);
      expect(setUserPreferences).not.toHaveBeenCalled();
    });
  });

  describe("isFeatureFlagEnabled", () => {
    it("returns false when userPrefs is null", () => {
      produceAppState((draft) => {
        draft.userPrefs = null;
      });
      expect(isFeatureFlagEnabled("meetingNotesEnabled")).toBe(false);
    });

    it("returns false for unknown flags", () => {
      produceAppState((draft) => {
        draft.userPrefs = createDefaultPreferences();
      });
      expect(isFeatureFlagEnabled("unknownFlag")).toBe(false);
    });

    it("returns the current flag value", () => {
      const prefs = createDefaultPreferences();
      prefs.connectorsEnabled = true;
      produceAppState((draft) => {
        draft.userPrefs = prefs;
      });
      expect(isFeatureFlagEnabled("connectorsEnabled")).toBe(true);
      expect(isFeatureFlagEnabled("meetingNotesEnabled")).toBe(false);
    });
  });
});
