import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import {
  createDefaultPreferences,
  setAgentToolEnabled,
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
      toolInfoById: { run_terminal_command: minimalToolInfo("run_terminal_command") },
      userPrefs: {
        ...createDefaultPreferences(),
        agentEnabledTools: null,
      },
    });

    await setAgentToolEnabled("run_terminal_command", true);

    expect(getAppState().userPrefs?.agentEnabledTools).toBeNull();
  });
});
