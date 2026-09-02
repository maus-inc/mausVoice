import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  setExpansionFlag,
  getExpansionFlags,
  isExpansionFeatureEnabled,
} from "./featureFlags";
import { getAppState, produceAppState } from "../store";
import { getUserPreferencesRepo } from "../repos";
import {
  DEFAULT_EXPANSION_FLAGS,
  parseExpansionFlags,
  serializeExpansionFlags,
} from "../types/expansion-flags.types";

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock("../store");
vi.mock("../repos");
vi.mock("../types/expansion-flags.types");
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: () => {},
    info: () => {},
    warning: () => {},
    verbose: () => {},
    stopwatch: async (_label: string, fn: () => Promise<unknown>) => fn(),
  }),
}));

describe("featureFlags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAppState as ReturnType<typeof vi.fn>).mockReturnValue({
      userPrefs: { expansionFlags: "{}" },
    });
    (parseExpansionFlags as ReturnType<typeof vi.fn>).mockImplementation(
      (raw: string) => (raw ? JSON.parse(raw) : { ...DEFAULT_EXPANSION_FLAGS }),
    );
    (serializeExpansionFlags as ReturnType<typeof vi.fn>).mockImplementation(
      (flags: Record<string, boolean>) => JSON.stringify(flags),
    );
  });

  describe("setExpansionFlag", () => {
    it("persists a single flag change", async () => {
      const mockUpdated = { expansionFlags: '{"meetingNotesEnabled":true}' };
      const mockRepo = {
        getUserPreferences: vi.fn().mockResolvedValue({ expansionFlags: "{}" }),
        setExpansionFlags: vi.fn().mockResolvedValue(mockUpdated),
      };
      (getUserPreferencesRepo as ReturnType<typeof vi.fn>).mockReturnValue(
        mockRepo,
      );

      await setExpansionFlag("meetingNotesEnabled", true);

      expect(mockRepo.setExpansionFlags).toHaveBeenCalledWith(
        JSON.stringify({ meetingNotesEnabled: true }),
      );
      expect(produceAppState).toHaveBeenCalled();
    });

    it("returns a rejected promise when the repo throws", async () => {
      const mockRepo = {
        getUserPreferences: vi.fn().mockResolvedValue({ expansionFlags: "{}" }),
        setExpansionFlags: vi.fn().mockRejectedValue(new Error("db error")),
      };
      (getUserPreferencesRepo as ReturnType<typeof vi.fn>).mockReturnValue(
        mockRepo,
      );

      await expect(
        setExpansionFlag("meetingNotesEnabled", true),
      ).rejects.toThrow("db error");
    });

    it("serializes concurrent toggles", async () => {
      const mockRepo = {
        getUserPreferences: vi.fn().mockResolvedValue({ expansionFlags: "{}" }),
        setExpansionFlags: vi
          .fn()
          .mockImplementation((flags: string) =>
            Promise.resolve({ expansionFlags: flags }),
          ),
      };
      (getUserPreferencesRepo as ReturnType<typeof vi.fn>).mockReturnValue(
        mockRepo,
      );

      const p1 = setExpansionFlag("meetingNotesEnabled", true);
      const p2 = setExpansionFlag("localApiEnabled", true);

      await Promise.all([p1, p2]);

      expect(mockRepo.setExpansionFlags).toHaveBeenCalledTimes(2);
    });

    it("recovers after a failure so later toggles still run", async () => {
      let callCount = 0;
      const mockRepo = {
        getUserPreferences: vi.fn().mockResolvedValue({ expansionFlags: "{}" }),
        setExpansionFlags: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error("db error"));
          }
          return Promise.resolve({
            expansionFlags: '{"localApiEnabled":true}',
          });
        }),
      };
      (getUserPreferencesRepo as ReturnType<typeof vi.fn>).mockReturnValue(
        mockRepo,
      );

      // Swallow the first failure so Promise.all can observe p2.
      const p1 = setExpansionFlag("meetingNotesEnabled", true).catch(() => {});
      const p2 = setExpansionFlag("localApiEnabled", true);

      await Promise.all([p1, p2]);

      expect(mockRepo.setExpansionFlags).toHaveBeenCalledTimes(2);
    });

    it("skips persistence when getUserPreferences returns null", async () => {
      const mockRepo = {
        getUserPreferences: vi.fn().mockResolvedValue(null),
        setExpansionFlags: vi.fn(),
      };
      (getUserPreferencesRepo as ReturnType<typeof vi.fn>).mockReturnValue(
        mockRepo,
      );

      await setExpansionFlag("meetingNotesEnabled", true);

      expect(mockRepo.setExpansionFlags).not.toHaveBeenCalled();
    });
  });

  describe("getExpansionFlags", () => {
    it("returns parsed flags from app state", () => {
      const flags = { meetingNotesEnabled: true };
      (getAppState as ReturnType<typeof vi.fn>).mockReturnValue({
        userPrefs: { expansionFlags: JSON.stringify(flags) },
      });
      (parseExpansionFlags as ReturnType<typeof vi.fn>).mockReturnValue(flags);

      const result = getExpansionFlags();

      expect(result).toEqual(flags);
    });
  });

  describe("isExpansionFeatureEnabled", () => {
    it("returns the flag value or false", () => {
      (getAppState as ReturnType<typeof vi.fn>).mockReturnValue({
        userPrefs: { expansionFlags: "{}" },
      });
      (parseExpansionFlags as ReturnType<typeof vi.fn>).mockReturnValue({
        meetingNotesEnabled: true,
      });

      expect(isExpansionFeatureEnabled("meetingNotesEnabled")).toBe(true);
      expect(isExpansionFeatureEnabled("localApiEnabled")).toBe(false);
    });
  });
});
