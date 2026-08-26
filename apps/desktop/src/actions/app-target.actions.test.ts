import type { AppTarget } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import { saveManualStyleForApp } from "./app-target.actions";

const { upsertAppTargetMock, getLoggerMock } = vi.hoisted(() => ({
  upsertAppTargetMock: vi.fn(
    async (params: {
      id: string;
      name: string;
      toneId: string | null;
      iconPath: string | null;
      pasteKeybind: string | null;
      insertionMethod: string | null;
      typingSpeedMs: number | null;
    }) => {
      return {
        id: params.id,
        name: params.name,
        createdAt: "2026-01-01T00:00:00.000Z",
        toneId: params.toneId,
        iconPath: params.iconPath,
        pasteKeybind: params.pasteKeybind,
        insertionMethod: params.insertionMethod,
        typingSpeedMs: params.typingSpeedMs,
      } satisfies AppTarget;
    },
  ),
  getLoggerMock: {
    verbose: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../repos", () => ({
  getAppTargetRepo: () => ({ upsertAppTarget: upsertAppTargetMock }),
  getStorageRepo: () => ({ getString: vi.fn(), setString: vi.fn() }),
}));

vi.mock("../utils/log.utils", () => ({ getLogger: () => getLoggerMock }));

const targetWithTone = (id: string, toneId: string | null): AppTarget => ({
  id,
  name: "TestApp",
  createdAt: "2026-01-01T00:00:00.000Z",
  toneId,
  iconPath: null,
  pasteKeybind: null,
  insertionMethod: null,
  typingSpeedMs: null,
});

const seedAppTarget = (target: AppTarget) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.appTargetById = { [target.id]: target };
  state.userById[LOCAL_USER_ID] = {
    id: LOCAL_USER_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Tester",
    onboarded: true,
    playInteractionChime: true,
    hasFinishedTutorial: true,
    wordsThisMonth: 0,
    wordsTotal: 0,
    stylingMode: "manual",
    selectedToneId: "default",
    activeToneIds: ["default", "email"],
  };
  state.toneById = {
    default: {
      id: "default",
      name: "Polished",
      promptTemplate: "",
      isSystem: true,
      createdAt: 0,
      sortOrder: 0,
    },
    email: {
      id: "email",
      name: "Email",
      promptTemplate: "",
      isSystem: true,
      createdAt: 0,
      sortOrder: 0,
    },
  };
  setAppState(state, true);
};

describe("saveManualStyleForApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("persists the live selection (not the start snapshot) to the app target", async () => {
    // User picked A at recording start, then switched to B mid-dictation.
    // The app target's previous tone was A; finalize must write B so the
    // next recording in this app starts with B and the live selection stays
    // B (not silently reverted to A).
    const target = targetWithTone("app-1", "default");
    seedAppTarget(target);

    getAppState().userById[LOCAL_USER_ID]!.selectedToneId = "email";

    const appTarget = { ...target, toneId: "default" };
    // The helper returns its persistence promise, so awaiting it is a
    // deterministic sync point (no zero-delay timer races).
    await saveManualStyleForApp(appTarget);

    expect(upsertAppTargetMock).toHaveBeenCalledTimes(1);
    expect(upsertAppTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "app-1", toneId: "email" }),
    );
    expect(getAppState().userById[LOCAL_USER_ID]?.selectedToneId).toBe("email");
  });

  it("does not rewrite the app target when the live selection already matches", async () => {
    const target = targetWithTone("app-1", "email");
    seedAppTarget(target);

    getAppState().userById[LOCAL_USER_ID]!.selectedToneId = "email";

    await saveManualStyleForApp(target);

    expect(upsertAppTargetMock).not.toHaveBeenCalled();
  });

  it("is a no-op in automatic styling mode", async () => {
    const target = targetWithTone("app-1", null);
    seedAppTarget(target);
    getAppState().userById[LOCAL_USER_ID]!.selectedToneId = "email";
    getAppState().userById[LOCAL_USER_ID]!.stylingMode = "app";

    await saveManualStyleForApp(target);

    expect(upsertAppTargetMock).not.toHaveBeenCalled();
  });
});
