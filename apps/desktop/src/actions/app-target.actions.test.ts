import type { AppTarget } from "@maus-inc/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  saveManualStyleForApp,
  loadManualStyleForCurrentApp,
  setAppTargetInsertionMethod,
  setAppTargetPasteKeybind,
  setAppTargetTone,
  setAppTargetTypingSpeed,
} from "./app-target.actions";

const { upsertAppTargetMock, getLoggerMock, invokeMock, selectToneMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    selectToneMock: vi.fn().mockResolvedValue(undefined),
    upsertAppTargetMock: vi.fn(
      (params: {
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
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: invokeMock,
}));
vi.mock("./user.actions", () => ({ setSelectedToneId: selectToneMock }));

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
    expect(upsertAppTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "app-1", toneId: "email" }),
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

  it("compares the style against the latest queued row, not a stale snapshot", async () => {
    const target = targetWithTone("app-1", "email");
    seedAppTarget(target);
    seededUser().selectedToneId = "email";
    let finish!: () => void;
    upsertAppTargetMock.mockImplementationOnce(
      (params) =>
        new Promise<AppTarget>((resolve) => {
          finish = () => resolve({ ...target, ...params });
        }) as unknown as AppTarget,
    );
    const first = setAppTargetTone(target.id, "default");
    const save = saveManualStyleForApp(target);
    finish();
    await Promise.all([first, save]);
    expect(upsertAppTargetMock).toHaveBeenCalledTimes(2);
    expect(getAppState().appTargetById[target.id].toneId).toBe("email");
  });

  it("does not dispatch a queued style save after its recording is retired", async () => {
    const target = targetWithTone("app-1", "default");
    seedAppTarget(target);
    seededUser().selectedToneId = "email";
    let finish!: () => void;
    upsertAppTargetMock.mockImplementationOnce(
      (params) =>
        new Promise<AppTarget>((resolve) => {
          finish = () => resolve({ ...target, ...params });
        }) as unknown as AppTarget,
    );
    const first = setAppTargetPasteKeybind(target.id, "Ctrl+V");
    let current = true;
    const save = saveManualStyleForApp(target, {
      toneId: "email",
      isCurrent: () => current,
    });
    current = false;
    finish();
    await Promise.all([first, save]);
    expect(upsertAppTargetMock).toHaveBeenCalledOnce();
    expect(getAppState().appTargetById[target.id].toneId).toBe("default");
  });

  it("preserves a newer style selection while an old save is queued", async () => {
    const target = targetWithTone("app-1", "default");
    seedAppTarget(target);
    seededUser().selectedToneId = "email";
    let finish!: () => void;
    upsertAppTargetMock.mockImplementationOnce(
      (params) =>
        new Promise<AppTarget>((resolve) => {
          finish = () => resolve({ ...target, ...params });
        }) as unknown as AppTarget,
    );
    const first = setAppTargetPasteKeybind(target.id, "Ctrl+V");
    const save = saveManualStyleForApp(target, {
      toneId: "email",
      isCurrent: () => true,
    });
    seededUser().selectedToneId = "default";
    finish();
    await Promise.all([first, save]);
    expect(upsertAppTargetMock).toHaveBeenCalledOnce();
    expect(getAppState().appTargetById[target.id].toneId).toBe("default");
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

describe("app target field updates", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    vi.restoreAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it.each([
    ["pasteKeybind", setAppTargetPasteKeybind, "Ctrl+V"],
    ["insertionMethod", setAppTargetInsertionMethod, "paste"],
    ["typingSpeedMs", setAppTargetTypingSpeed, 50],
  ] as const)(
    "updates %s while preserving other fields",
    async (field, update, value) => {
      const target = {
        ...targetWithTone("app", "email"),
        iconPath: "icon.png",
        pasteKeybind: "old",
        insertionMethod: "type",
        typingSpeedMs: 20,
      };
      seedAppTarget(target);
      // Each table row pairs the setter with its corresponding value.
      await (
        update as (id: string, value: string | number | null) => Promise<void>
      )("app", value);
      expect(upsertAppTargetMock).toHaveBeenCalledWith({
        id: target.id,
        name: target.name,
        toneId: target.toneId,
        iconPath: target.iconPath,
        pasteKeybind: target.pasteKeybind,
        insertionMethod: target.insertionMethod,
        typingSpeedMs: target.typingSpeedMs,
        [field]: value,
      });
      expect(getAppState().appTargetById.app[field]).toBe(value);
    },
  );

  it("writes null to clear a field instead of retaining the old value", async () => {
    seedAppTarget({
      ...targetWithTone("app", "email"),
      pasteKeybind: "Ctrl+V",
    });
    await setAppTargetPasteKeybind("app", null);
    expect(upsertAppTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({ pasteKeybind: null }),
    );
    expect(getAppState().appTargetById.app.pasteKeybind).toBeNull();
  });

  it("does not persist a missing target or change state on failure", async () => {
    seedAppTarget(targetWithTone("app", "email"));
    await setAppTargetTypingSpeed("missing", 10);
    expect(upsertAppTargetMock).not.toHaveBeenCalled();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    upsertAppTargetMock.mockImplementationOnce(() => {
      throw new Error("disk failed");
    });
    await setAppTargetInsertionMethod("app", "paste");
    expect(getAppState().appTargetById.app.insertionMethod).toBeNull();
  });
});

describe("loadManualStyleForCurrentApp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAppTarget(targetWithTone("editor", "email"));
  });
  afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

  it("passes a queue-time guard that respects retirement and manual changes", async () => {
    invokeMock.mockResolvedValueOnce({ appName: "Editor" });
    let current = true;
    await loadManualStyleForCurrentApp(() => current);
    expect(selectToneMock).toHaveBeenCalledOnce();
    expect(selectToneMock.mock.calls[0]?.[0]).toBe("email");
    const shouldApply = selectToneMock.mock.calls[0]?.[1] as () => boolean;
    expect(shouldApply()).toBe(true);
    seededUser().selectedToneId = "email";
    expect(shouldApply()).toBe(false);
    seededUser().selectedToneId = "default";
    current = false;
    expect(shouldApply()).toBe(false);
  });

  it("bounds a stalled app lookup and retires its late result", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: unknown) => void;
      invokeMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const load = loadManualStyleForCurrentApp();
      await vi.advanceTimersByTimeAsync(2_000);
      await load;
      finish({ appName: "Editor" });
      await Promise.resolve();
      await Promise.resolve();
      expect(selectToneMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never queues a style selection when the recording was retired during lookup", async () => {
    let finish!: (value: unknown) => void;
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let current = true;
    const load = loadManualStyleForCurrentApp(() => current);
    current = false;
    finish({ appName: "Editor" });
    await load;
    expect(selectToneMock).not.toHaveBeenCalled();
  });
});
