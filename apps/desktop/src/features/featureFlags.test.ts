import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  setExpansionFlag,
  getExpansionFlags,
  isExpansionFeatureEnabled,
} from "./featureFlags";
import { getAppState, produceAppState } from "../store";
import { getUserPreferencesRepo } from "../repos";
import type { BaseUserPreferencesRepo } from "../repos/preferences.repo";
import { createDefaultPreferences } from "../actions/user.actions";
import {
  DEFAULT_EXPANSION_FLAGS,
  parseExpansionFlags,
  serializeExpansionFlags,
} from "../types/expansion-flags.types";

vi.mock("../store");
vi.mock("../repos");
vi.mock("../types/expansion-flags.types");
const ephemeralSessionMock = vi.hoisted(() => ({
  startEphemeralSession: vi.fn(() => Promise.resolve(undefined)),
  endEphemeralSession: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("../actions/ephemeral-session.actions", () => ephemeralSessionMock);
const logger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  verbose: vi.fn(),
  stopwatch: (_label: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => logger }));

const withFlags = (expansionFlags: string) => ({
  ...createDefaultPreferences(),
  expansionFlags,
});

const createRepoMock = () =>
  ({
    getUserPreferences: vi
      .fn<BaseUserPreferencesRepo["getUserPreferences"]>()
      .mockResolvedValue(withFlags("{}")),
    setUserPreferences: vi.fn<BaseUserPreferencesRepo["setUserPreferences"]>(),
    setExpansionFlags: vi.fn<BaseUserPreferencesRepo["setExpansionFlags"]>(),
    compareAndSetExpansionFlags:
      vi.fn<BaseUserPreferencesRepo["compareAndSetExpansionFlags"]>(),
  }) satisfies BaseUserPreferencesRepo;

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
      const mockUpdated = withFlags('{"meetingNotesEnabled":true}');
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(mockUpdated);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await setExpansionFlag("meetingNotesEnabled", true);

      expect(mockRepo.compareAndSetExpansionFlags).toHaveBeenCalledWith(
        "{}",
        JSON.stringify({ meetingNotesEnabled: true }),
      );
      expect(produceAppState).toHaveBeenCalled();
    });

    it("starts an ephemeral session when its flag is turned on", async () => {
      const mockUpdated = withFlags('{"ephemeralSessionEnabled":true}');
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(mockUpdated);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await setExpansionFlag("ephemeralSessionEnabled", true);

      // Without this the preference offers a session that never begins, so
      // persistence is never actually suppressed.
      expect(ephemeralSessionMock.startEphemeralSession).toHaveBeenCalledTimes(
        1,
      );
      expect(ephemeralSessionMock.endEphemeralSession).not.toHaveBeenCalled();
    });

    it("ends the ephemeral session when its flag is turned off", async () => {
      const mockUpdated = withFlags('{"ephemeralSessionEnabled":false}');
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(mockUpdated);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await setExpansionFlag("ephemeralSessionEnabled", false);

      expect(ephemeralSessionMock.endEphemeralSession).toHaveBeenCalledTimes(1);
      expect(ephemeralSessionMock.startEphemeralSession).not.toHaveBeenCalled();
    });

    it("does not run a session when another expansion flag is toggled", async () => {
      const mockUpdated = withFlags('{"meetingNotesEnabled":true}');
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(mockUpdated);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await setExpansionFlag("meetingNotesEnabled", true);

      expect(ephemeralSessionMock.startEphemeralSession).not.toHaveBeenCalled();
      expect(ephemeralSessionMock.endEphemeralSession).not.toHaveBeenCalled();
    });

    it("does not run a session for a compare-and-set that never won", async () => {
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(null);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await expect(
        setExpansionFlag("ephemeralSessionEnabled", true),
      ).rejects.toThrow("changed repeatedly");

      // The flag was never persisted, so a session must not be left running
      // behind a preference that still reads off.
      expect(ephemeralSessionMock.startEphemeralSession).not.toHaveBeenCalled();
      expect(ephemeralSessionMock.endEphemeralSession).not.toHaveBeenCalled();
    });

    it("returns a rejected promise when the repo throws", async () => {
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockRejectedValue(
        new Error("db error"),
      );
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await expect(
        setExpansionFlag("meetingNotesEnabled", true),
      ).rejects.toThrow("db error");
      expect(logger.error).toHaveBeenCalledWith("Failed to set expansion flag");
    });

    it("serializes concurrent toggles without losing either update", async () => {
      let stored = "{}";
      const mockRepo = createRepoMock();
      mockRepo.getUserPreferences.mockImplementation(() =>
        Promise.resolve(withFlags(stored)),
      );
      mockRepo.compareAndSetExpansionFlags.mockImplementation(
        async (_expected, flags) => {
          await Promise.resolve();
          stored = flags;
          return withFlags(stored);
        },
      );
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await Promise.all([
        setExpansionFlag("meetingNotesEnabled", true),
        setExpansionFlag("localApiEnabled", true),
      ]);

      expect(JSON.parse(stored)).toEqual({
        meetingNotesEnabled: true,
        localApiEnabled: true,
      });
    });

    it("recovers after a failure so later toggles still run", async () => {
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags
        .mockRejectedValueOnce(new Error("db error"))
        .mockResolvedValue(withFlags('{"localApiEnabled":true}'));
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      // Swallow the first failure so Promise.all can observe p2.
      const p1 = setExpansionFlag("meetingNotesEnabled", true).catch(
        () => undefined,
      );
      const p2 = setExpansionFlag("localApiEnabled", true);

      await Promise.all([p1, p2]);

      expect(mockRepo.compareAndSetExpansionFlags).toHaveBeenCalledTimes(2);
    });

    it("retries an external writer conflict without losing that writer's flag", async () => {
      let stored = "{}";
      let conflict = true;
      const externalWrite = () => {
        if (!conflict) return false;
        conflict = false;
        stored = '{"localApiEnabled":true}';
        return true;
      };
      const mockRepo = createRepoMock();
      mockRepo.getUserPreferences.mockImplementation(() =>
        Promise.resolve(withFlags(stored)),
      );
      mockRepo.setExpansionFlags.mockImplementation((flags) => {
        externalWrite();
        stored = flags;
        return Promise.resolve(withFlags(stored));
      });
      mockRepo.compareAndSetExpansionFlags.mockImplementation(
        (expected, flags) => {
          if (externalWrite() || expected !== stored)
            return Promise.resolve(null);
          stored = flags;
          return Promise.resolve(withFlags(stored));
        },
      );
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);
      await setExpansionFlag("meetingNotesEnabled", true);
      expect(JSON.parse(stored)).toEqual({
        localApiEnabled: true,
        meetingNotesEnabled: true,
      });
      expect(mockRepo.compareAndSetExpansionFlags).toHaveBeenCalledTimes(2);
      expect(mockRepo.setExpansionFlags).not.toHaveBeenCalled();
    });

    it("bounds repeated conflicts and leaves the queue usable", async () => {
      const mockRepo = createRepoMock();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(null);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await expect(
        setExpansionFlag("meetingNotesEnabled", true),
      ).rejects.toThrow("changed repeatedly");
      expect(mockRepo.compareAndSetExpansionFlags).toHaveBeenCalledTimes(5);
      expect(produceAppState).not.toHaveBeenCalled();
      mockRepo.compareAndSetExpansionFlags.mockResolvedValue(
        withFlags('{"localApiEnabled":true}'),
      );
      await setExpansionFlag("localApiEnabled", true);
      expect(produceAppState).toHaveBeenCalledOnce();
    });

    it("skips persistence when getUserPreferences returns null", async () => {
      const mockRepo = createRepoMock();
      mockRepo.getUserPreferences.mockResolvedValue(null);
      vi.mocked(getUserPreferencesRepo).mockReturnValue(mockRepo);

      await setExpansionFlag("meetingNotesEnabled", true);

      expect(mockRepo.compareAndSetExpansionFlags).not.toHaveBeenCalled();
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
