import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPANSION_FLAGS,
  type ExpansionFlags,
  type ExpansionFeatureName,
  EXPANSION_FLAG_NAMES,
  isExpansionFlagEnabled,
  parseExpansionFlags,
  serializeExpansionFlags,
} from "./expansion-flags.types";

describe("expansion-flags.types", () => {
  describe("parseExpansionFlags", () => {
    it("returns defaults for null input", () => {
      expect(parseExpansionFlags(null)).toEqual(DEFAULT_EXPANSION_FLAGS);
    });

    it("returns defaults for undefined input", () => {
      expect(parseExpansionFlags(undefined)).toEqual(DEFAULT_EXPANSION_FLAGS);
    });

    it("returns defaults for empty string", () => {
      expect(parseExpansionFlags("")).toEqual(DEFAULT_EXPANSION_FLAGS);
    });

    it("returns defaults for invalid JSON", () => {
      expect(parseExpansionFlags("not-json")).toEqual(DEFAULT_EXPANSION_FLAGS);
    });

    it("parses valid JSON and fills missing flags with defaults", () => {
      const parsed = parseExpansionFlags(
        JSON.stringify({ meetingNotesEnabled: true }),
      );
      expect(parsed.meetingNotesEnabled).toBe(true);
      expect(parsed.localApiEnabled).toBe(false);
    });

    it("ignores unknown flag names", () => {
      const parsed = parseExpansionFlags(JSON.stringify({ unknownFlag: true }));
      expect(parsed).toEqual(DEFAULT_EXPANSION_FLAGS);
    });
  });

  describe("serializeExpansionFlags", () => {
    it("serializes flags to JSON", () => {
      const flags: ExpansionFlags = {
        ...DEFAULT_EXPANSION_FLAGS,
        meetingNotesEnabled: true,
      };
      const serialized = serializeExpansionFlags(flags);
      expect(JSON.parse(serialized)).toEqual(flags);
    });
  });

  describe("isExpansionFlagEnabled", () => {
    it("returns the flag value when set", () => {
      const flags: ExpansionFlags = {
        ...DEFAULT_EXPANSION_FLAGS,
        meetingNotesEnabled: true,
      };
      expect(isExpansionFlagEnabled(flags, "meetingNotesEnabled")).toBe(true);
      expect(isExpansionFlagEnabled(flags, "localApiEnabled")).toBe(false);
    });

    it("returns false for missing flags", () => {
      const flags = {} as ExpansionFlags;
      expect(
        isExpansionFlagEnabled(
          flags,
          "meetingNotesEnabled" as ExpansionFeatureName,
        ),
      ).toBe(false);
    });
  });

  describe("EXPANSION_FLAG_NAMES", () => {
    it("contains all expected flag names", () => {
      expect(EXPANSION_FLAG_NAMES).toEqual([
        "meetingNotesEnabled",
        "localApiEnabled",
        "translationsEnabled",
        "connectorsEnabled",
        "handsFreeToggleEnabled",
        "voiceWorkflowsEnabled",
      ]);
    });
  });
});
