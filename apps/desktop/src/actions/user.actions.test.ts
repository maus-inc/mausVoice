import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  createDefaultPreferences,
  setAgentToolEnabled,
  setPreserveAudioOnFailure,
  setPillPlacement,
  setRealtimeOutputEnabled,
  setReviewBeforeInsert,
} from "./user.actions";
import type { ToolInfo } from "@maus-inc/types";

const { loggerMock, prefsRepoMock } = vi.hoisted(() => {
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
  return { loggerMock, prefsRepoMock };
});

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeMock };
});

vi.mock("../utils/log.utils", () => ({ getLogger: () => loggerMock }));

vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => prefsRepoMock,
  getUserRepo: () => ({}),
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
