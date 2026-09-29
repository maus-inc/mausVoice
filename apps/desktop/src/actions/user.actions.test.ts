import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  createDefaultPreferences,
  refreshCurrentUser,
  setAgentToolEnabled,
  setPreserveAudioOnFailure,
  setPillPlacement,
  setPreferredLanguage,
  setRealtimeOutputEnabled,
  setReviewBeforeInsert,
  setUserName,
} from "./user.actions";
import type { ToolInfo, User } from "@maus-inc/types";

const { loggerMock, prefsRepoMock, userRepoMock } = vi.hoisted(() => {
  const loggerMock = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    stopwatch: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
  const prefsRepoMock = {
    setUserPreferences: vi.fn(async (preferences: unknown) => preferences),
    getUserPreferences: vi.fn(async () => null),
  };
  const userRepoMock = {
    setMyUser: vi.fn<(user: User) => Promise<User>>(async (user) => user),
    getMyUser: vi.fn<() => Promise<User | null>>(async () => null),
  };
  return { loggerMock, prefsRepoMock, userRepoMock };
});

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => prefsRepoMock,
  getUserRepo: () => userRepoMock,
}));

const minimalToolInfo = (id: string): ToolInfo =>
  ({
    id,
    description: id,
    instructions: id,
    schema: {},
  }) as ToolInfo;

describe("setPillPlacement", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  it("persists the preference and pushes the same placement to native", async () => {
    await setPillPlacement("top");

    expect(prefsRepoMock.setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ pillPlacement: "top" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("set_pill_placement", {
      placement: "top",
    });
  });

  it("keeps the preference saved when the native push fails and logs once", async () => {
    invokeMock.mockRejectedValueOnce(new Error("native down"));

    await setPillPlacement("bottom");

    // The preference write is the source of truth and must survive.
    expect(prefsRepoMock.setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ pillPlacement: "bottom" }),
    );
    expect(loggerMock.warning).toHaveBeenCalledTimes(1);
    expect(loggerMock.warning.mock.calls[0][0]).toContain(
      "Failed to push pill placement to native pill",
    );
  });
});

describe("setPreserveAudioOnFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("persists a user's choice to discard audio from failed transcriptions", async () => {
    await setPreserveAudioOnFailure(false);

    expect(getAppState().userPrefs?.preserveAudioOnFailure).toBe(false);
    expect(prefsRepoMock.setUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ preserveAudioOnFailure: false }),
    );
  });
});

describe("setAgentToolEnabled empty-registry guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("preserves an explicit deny-all ([]) when the tool registry is momentarily empty", async () => {
    setAppState({
      toolInfoById: {},
      userPrefs: {
        ...createDefaultPreferences(),
        agentEnabledTools: [],
      },
    });

    await setAgentToolEnabled("run_terminal_command", true);

    const result = getAppState().userPrefs?.agentEnabledTools;
    expect(result).not.toBeNull();
    expect(result).toEqual(["run_terminal_command"]);
  });

  it("collapses to null (follow registry defaults) when every known tool is enabled", async () => {
    setAppState({
      toolInfoById: {
        run_terminal_command: minimalToolInfo("run_terminal_command"),
      },
      userPrefs: {
        ...createDefaultPreferences(),
        agentEnabledTools: null,
      },
    });

    await setAgentToolEnabled("run_terminal_command", true);

    expect(getAppState().userPrefs?.agentEnabledTools).toBeNull();
  });
});

describe("real-time output vs review-before-insert mutual exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("enabling real-time output turns review-before-insert off", async () => {
    setAppState({
      userPrefs: {
        ...createDefaultPreferences(),
        reviewBeforeInsert: true,
      },
    });

    await setRealtimeOutputEnabled(true);

    const prefs = getAppState().userPrefs;
    expect(prefs?.realtimeOutputEnabled).toBe(true);
    expect(prefs?.reviewBeforeInsert).toBe(false);
  });

  it("enabling review-before-insert turns real-time output off", async () => {
    setAppState({
      userPrefs: {
        ...createDefaultPreferences(),
        realtimeOutputEnabled: true,
      },
    });

    await setReviewBeforeInsert(true);

    const prefs = getAppState().userPrefs;
    expect(prefs?.reviewBeforeInsert).toBe(true);
    expect(prefs?.realtimeOutputEnabled).toBe(false);
  });

  it("leaves the other preference alone when disabling", async () => {
    setAppState({
      userPrefs: {
        ...createDefaultPreferences(),
        reviewBeforeInsert: true,
        realtimeOutputEnabled: false,
      },
    });

    await setRealtimeOutputEnabled(false);

    expect(getAppState().userPrefs?.reviewBeforeInsert).toBe(true);
  });
});

/**
 * `setMyUser` upserts the whole profile row. The save used to run behind an
 * `AsyncLock`, which only counted callers: both writes were in flight at once
 * and the slower one won, reverting every field the other had changed. These
 * tests drive the queue deterministically with a controlled promise rather than
 * with timers, so the interleaving is the same on every run.
 */
describe("updateUser serialization", () => {
  const baseUser: User = {
    id: LOCAL_USER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Before",
    bio: null,
    onboarded: true,
    onboardedAt: "2026-01-01T00:00:00.000Z",
    playInteractionChime: true,
    hasFinishedTutorial: false,
    wordsThisMonth: 0,
    wordsTotal: 0,
  };

  const deferred = () => {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, so an unconsumed `…Once` value
    // from an earlier test would leak into the next one. Reset explicitly and
    // re-seed the defaults.
    userRepoMock.setMyUser.mockReset();
    userRepoMock.getMyUser.mockReset();
    userRepoMock.setMyUser.mockImplementation(async (user) => user);
    userRepoMock.getMyUser.mockResolvedValue(null);
    setAppState(
      {
        ...structuredClone(INITIAL_APP_STATE),
        userById: { [LOCAL_USER_ID]: baseUser },
      },
      true,
    );
  });

  afterEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("lands both mutations when two updates overlap", async () => {
    const gate = deferred();
    const firstWriteStarted = deferred();
    // The first write is held open. The row is written when the write RESOLVES,
    // which is what a real database does, so a slower earlier write clobbers a
    // faster later one.
    const writes: User[] = [];
    let calls = 0;
    userRepoMock.setMyUser.mockImplementation(async (user) => {
      calls += 1;
      if (calls === 1) {
        firstWriteStarted.release();
        await gate.promise;
      }
      writes.push(user);
      return user;
    });

    const first = setUserName("Renamed");
    const second = setPreferredLanguage("fr");
    await firstWriteStarted.promise;
    gate.release();
    await Promise.all([first, second]);

    expect(writes).toHaveLength(2);
    expect(writes.at(-1)?.name).toBe("Renamed");
    expect(writes.at(-1)?.preferredLanguage).toBe("fr");
    expect(getAppState().userById[LOCAL_USER_ID]?.name).toBe("Renamed");
    expect(getAppState().userById[LOCAL_USER_ID]?.preferredLanguage).toBe("fr");
  });

  it("re-reads the row after a failed save instead of restoring a snapshot", async () => {
    // Another writer committed `bio` between this mutation being queued and its
    // save failing. A snapshot rollback would erase that commit.
    const committed: User = { ...baseUser, bio: "Committed elsewhere" };
    userRepoMock.setMyUser.mockRejectedValueOnce(new Error("disk full"));
    userRepoMock.getMyUser.mockResolvedValueOnce(committed);

    await expect(setUserName("Renamed")).rejects.toThrow("disk full");

    expect(userRepoMock.getMyUser).toHaveBeenCalledTimes(1);
    expect(getAppState().userById[LOCAL_USER_ID]?.bio).toBe(
      "Committed elsewhere",
    );
  });

  it("runs refreshCurrentUser on the same chain without deadlocking", async () => {
    const gate = deferred();
    const firstWriteStarted = deferred();
    let calls = 0;
    userRepoMock.setMyUser.mockImplementation(async (user) => {
      calls += 1;
      if (calls === 1) {
        firstWriteStarted.release();
        await gate.promise;
      }
      return user;
    });
    userRepoMock.getMyUser.mockResolvedValue({
      ...baseUser,
      name: "From disk",
    });

    const save = setUserName("Renamed");
    // Enqueued while the save is still in flight. If refreshCurrentUser were
    // ever called from inside a queued task, this would wait on itself.
    const refresh = refreshCurrentUser();
    await firstWriteStarted.promise;
    gate.release();
    await Promise.all([save, refresh]);

    expect(userRepoMock.getMyUser).toHaveBeenCalled();
    expect(getAppState().userById[LOCAL_USER_ID]?.name).toBe("From disk");
  });
});
