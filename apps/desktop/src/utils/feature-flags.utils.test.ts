import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultPreferences } from "../actions/user.actions";
import { produceAppState } from "../store";
import {
  getAllFeatureFlags,
  isFeatureEnabled,
  isValidFeatureFlag,
} from "./feature-flags.utils";

describe("feature-flags.utils", () => {
  beforeEach(() => {
    produceAppState((draft) => {
      draft.userPrefs = null;
    });
  });

  describe("isValidFeatureFlag", () => {
    it("returns true for valid flags", () => {
      expect(isValidFeatureFlag("meetingNotesEnabled")).toBe(true);
      expect(isValidFeatureFlag("connectorsEnabled")).toBe(true);
      expect(isValidFeatureFlag("voiceWorkflowsEnabled")).toBe(true);
    });

    it("returns false for invalid flags", () => {
      expect(isValidFeatureFlag("unknownFlag")).toBe(false);
      expect(isValidFeatureFlag("")).toBe(false);
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns false when userPrefs is null", () => {
      produceAppState((draft) => {
        draft.userPrefs = null;
      });
      expect(isFeatureEnabled("meetingNotesEnabled")).toBe(false);
    });

    it("returns false for invalid flags", () => {
      produceAppState((draft) => {
        draft.userPrefs = createDefaultPreferences();
      });
      expect(isFeatureEnabled("invalidFlag")).toBe(false);
    });

    it("returns the current flag value", () => {
      const prefs = createDefaultPreferences();
      prefs.translationsEnabled = true;
      produceAppState((draft) => {
        draft.userPrefs = prefs;
      });
      expect(isFeatureEnabled("translationsEnabled")).toBe(true);
      expect(isFeatureEnabled("meetingNotesEnabled")).toBe(false);
    });
  });

  describe("getAllFeatureFlags", () => {
    it("returns all flags false when userPrefs is null", () => {
      produceAppState((draft) => {
        draft.userPrefs = null;
      });
      const result = getAllFeatureFlags();
      expect(result.meetingNotesEnabled).toBe(false);
      expect(result.connectorsEnabled).toBe(false);
    });

    it("returns current state of all flags", () => {
      const prefs = createDefaultPreferences();
      prefs.webhooksEnabled = true;
      prefs.handsFreeToggleEnabled = true;
      produceAppState((draft) => {
        draft.userPrefs = prefs;
      });
      const result = getAllFeatureFlags();
      expect(result.webhooksEnabled).toBe(true);
      expect(result.handsFreeToggleEnabled).toBe(true);
      expect(result.meetingNotesEnabled).toBe(false);
    });
  });
});
