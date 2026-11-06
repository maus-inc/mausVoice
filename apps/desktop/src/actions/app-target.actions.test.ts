import type { AppTarget } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
  type LocalDataWriteLease,
} from "../utils/local-data-write-gate";
import {
  saveManualStyleForApp,
  loadAppTargets,
  setAppTargetTone,
  setAppTargetTypingSpeed,
  setAppTargetInsertionMethod,
} from "./app-target.actions";

const { upsertAppTargetMock, listAppTargetsMock, getLoggerMock } = vi.hoisted(
  () => ({
    listAppTargetsMock: vi.fn<() => Promise<AppTarget[]>>(),
    upsertAppTargetMock: vi.fn(
      (
        params: {
          id: string;
          name: string;
          toneId: string | null;
          iconPath: string | null;
          pasteKeybind: string | null;
          insertionMethod: string | null;
          typingSpeedMs: number | null;
        },
        _lease?: LocalDataWriteLease,
      ): AppTarget | Promise<AppTarget> => {
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
  }),
);

vi.mock("../repos", () => ({
  getAppTargetRepo: () => ({
    upsertAppTarget: upsertAppTargetMock,
    listAppTargets: listAppTargetsMock,
  }),
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
beforeEach(() => {
  listAppTargetsMock.mockImplementation(() =>
    Promise.resolve(Object.values(getAppState().appTargetById)),
  );
});

const seededUser = () => {
  const user = getAppState().userById[LOCAL_USER_ID];
  if (!user) throw new Error("seedAppTarget must run first");
  return user;
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

    seededUser().selectedToneId = "email";

    const appTarget = { ...target, toneId: "default" };
    // The helper returns its persistence promise, so awaiting it is a
    // deterministic sync point (no zero-delay timer races).
    await saveManualStyleForApp(appTarget);

    expect(upsertAppTargetMock).toHaveBeenCalledTimes(1);
    expect(upsertAppTargetMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: "app-1", toneId: "email" }),
    );
    expect(upsertAppTargetMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({}),
    );
    expect(getAppState().userById[LOCAL_USER_ID]?.selectedToneId).toBe("email");
  });

  it("does not rewrite the app target when the live selection already matches", async () => {
    const target = targetWithTone("app-1", "email");
    seedAppTarget(target);

    seededUser().selectedToneId = "email";

    await saveManualStyleForApp(target);

    expect(upsertAppTargetMock).not.toHaveBeenCalled();
  });

  it("is a no-op in automatic styling mode", async () => {
    const target = targetWithTone("app-1", null);
    seedAppTarget(target);
    seededUser().selectedToneId = "email";
    seededUser().stylingMode = "app";

    await saveManualStyleForApp(target);

    expect(upsertAppTargetMock).not.toHaveBeenCalled();
  });
});

describe("setAppTargetTone result", () => {
  it("reports successful activation", async () => {
    seedAppTarget(targetWithTone("app", "default"));
    expect(await setAppTargetTone("app", "email")).toBe(true);
    expect(getAppState().appTargetById.app.toneId).toBe("email");
  });
  it("reports a missing target", async () => {
    seedAppTarget(targetWithTone("app", "default"));
    expect(await setAppTargetTone("missing", "email")).toBe(false);
  });
  it("reports failed persistence and preserves the existing assignment", async () => {
    seedAppTarget(targetWithTone("app", "default"));
    upsertAppTargetMock.mockImplementationOnce(() => {
      throw new Error("storage failed");
    });
    expect(await setAppTargetTone("app", "email")).toBe(false);
    expect(getAppState().appTargetById.app.toneId).toBe("default");
  });
});

describe("concurrent app target changes", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("serializes rapid slider commits and preserves changes to other fields", async () => {
    const target = targetWithTone("app", "default");
    seedAppTarget(target);
    let release!: (target: AppTarget) => void;
    const firstWrite = new Promise<AppTarget>((resolve) => {
      release = resolve;
    });
    upsertAppTargetMock.mockImplementationOnce(() => firstWrite);
    const first = setAppTargetTypingSpeed("app", 10);
    const second = setAppTargetInsertionMethod("app", "type");
    const third = setAppTargetTypingSpeed("app", 30);
    try {
      await vi.waitFor(() =>
        expect(upsertAppTargetMock).toHaveBeenCalledTimes(1),
      );
      release({ ...target, typingSpeedMs: 10 });
      await Promise.all([first, second, third]);
      expect(upsertAppTargetMock).toHaveBeenCalledTimes(3);
      expect(upsertAppTargetMock.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ typingSpeedMs: 10, insertionMethod: "type" }),
      );
      expect(upsertAppTargetMock.mock.calls[2]?.[0]).toEqual(
        expect.objectContaining({ typingSpeedMs: 30, insertionMethod: "type" }),
      );
      expect(getAppState().appTargetById.app).toEqual(
        expect.objectContaining({ typingSpeedMs: 30, insertionMethod: "type" }),
      );
    } finally {
      release({ ...target, typingSpeedMs: 10 });
      await Promise.allSettled([first, second, third]);
    }
  });

  it("retains queued writes until a local-data clear can safely proceed", async () => {
    const target = targetWithTone("app", "default");
    seedAppTarget(target);
    let releaseWrite!: (target: AppTarget) => void;
    const pending = new Promise<AppTarget>((resolve) => {
      releaseWrite = resolve;
    });
    let releaseSecond!: (target: AppTarget) => void;
    const pendingSecond = new Promise<AppTarget>((resolve) => {
      releaseSecond = resolve;
    });
    upsertAppTargetMock
      .mockImplementationOnce(() => pending)
      .mockImplementationOnce(() => pendingSecond);
    const first = setAppTargetTypingSpeed("app", 10);
    const second = setAppTargetTypingSpeed("app", 20);
    let clearFinished = false;
    const clear = beginLocalDataClear().then((release) => {
      clearFinished = true;
      return release;
    });
    try {
      await vi.waitFor(() =>
        expect(upsertAppTargetMock).toHaveBeenCalledTimes(1),
      );
      expect(clearFinished).toBe(false);
      releaseWrite({ ...target, typingSpeedMs: 10 });
      await vi.waitFor(() =>
        expect(upsertAppTargetMock).toHaveBeenCalledTimes(2),
      );
      expect(clearFinished).toBe(false);
      releaseSecond({ ...target, typingSpeedMs: 20 });
      await Promise.all([first, second]);
      const releaseClear = await clear;
      expect(upsertAppTargetMock).toHaveBeenCalledTimes(2);
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
    } finally {
      releaseWrite({ ...target, typingSpeedMs: 10 });
      releaseSecond({ ...target, typingSpeedMs: 20 });
      const releaseClear = await clear;
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
      await Promise.allSettled([first, second]);
    }
  });

  it("discards a refresh that completes after local data is cleared", async () => {
    const target = targetWithTone("app", "default");
    seedAppTarget(target);
    let releaseRead!: (targets: AppTarget[]) => void;
    const read = new Promise<AppTarget[]>((resolve) => {
      releaseRead = resolve;
    });
    listAppTargetsMock.mockReturnValueOnce(read);
    const refresh = loadAppTargets();
    let releaseClear: (() => void) | undefined;
    try {
      await vi.waitFor(() =>
        expect(listAppTargetsMock).toHaveBeenCalledTimes(1),
      );
      releaseClear = await beginLocalDataClear();
      setAppState(structuredClone(INITIAL_APP_STATE), true);
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear();
      releaseRead([target]);
      await refresh;
      expect(getAppState().appTargetById.app).toBeUndefined();
    } finally {
      releaseRead([target]);
      localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
      releaseClear?.();
      await Promise.allSettled([refresh]);
    }
  });

  it("waits for an in-flight refresh before deriving a mutation", async () => {
    const target = targetWithTone("app", "default");
    seedAppTarget(target);
    let release!: (targets: AppTarget[]) => void;
    const read = new Promise<AppTarget[]>((resolve) => {
      release = resolve;
    });
    listAppTargetsMock.mockReturnValueOnce(read);
    const refresh = loadAppTargets();
    const save = setAppTargetTypingSpeed("app", 20);
    try {
      await vi.waitFor(() =>
        expect(listAppTargetsMock).toHaveBeenCalledTimes(1),
      );
      expect(upsertAppTargetMock).not.toHaveBeenCalled();
      release([{ ...target, insertionMethod: "type" }]);
      await Promise.all([refresh, save]);
      expect(upsertAppTargetMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ typingSpeedMs: 20, insertionMethod: "type" }),
      );
    } finally {
      release([target]);
      await Promise.allSettled([refresh, save]);
    }
  });

  it("reconciles an uncertain commit before applying the next field change", async () => {
    const target = targetWithTone("app", "default");
    seedAppTarget(target);
    upsertAppTargetMock.mockImplementationOnce(() =>
      Promise.reject(new Error("response lost")),
    );
    listAppTargetsMock.mockResolvedValueOnce([
      { ...target, typingSpeedMs: 10 },
    ]);
    await setAppTargetTypingSpeed("app", 10);
    await setAppTargetInsertionMethod("app", "type");
    expect(upsertAppTargetMock.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ typingSpeedMs: 10, insertionMethod: "type" }),
    );
  });

  it("does not write over an uncertain target if the recovery read fails", async () => {
    seedAppTarget(targetWithTone("app", "default"));
    upsertAppTargetMock.mockImplementationOnce(() =>
      Promise.reject(new Error("response lost")),
    );
    listAppTargetsMock
      .mockRejectedValueOnce(new Error("read failed"))
      .mockRejectedValueOnce(new Error("read failed again"));
    await setAppTargetTypingSpeed("app", 10);
    await setAppTargetTypingSpeed("app", 20);
    expect(upsertAppTargetMock).toHaveBeenCalledTimes(1);
    await setAppTargetTypingSpeed("app", 30);
    expect(upsertAppTargetMock).toHaveBeenCalledTimes(2);
    expect(getAppState().appTargetById.app.typingSpeedMs).toBe(30);
  });

  it("continues later writes after a failed save", async () => {
    seedAppTarget(targetWithTone("app", "default"));
    upsertAppTargetMock.mockImplementationOnce(() =>
      Promise.reject(new Error("save failed")),
    );
    const first = setAppTargetTypingSpeed("app", 10);
    const second = setAppTargetTypingSpeed("app", 30);
    await expect(Promise.all([first, second])).resolves.toEqual([false, true]);
    expect(upsertAppTargetMock).toHaveBeenCalledTimes(2);
    expect(getAppState().appTargetById.app.typingSpeedMs).toBe(30);
  });
});
