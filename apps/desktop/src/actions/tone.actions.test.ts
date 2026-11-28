import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppState, produceAppState, setAppState } from "../store";
import { INITIAL_APP_STATE } from "../state/app.state";
import { LOCAL_USER_ID } from "../utils/user.utils";
import {
  beginLocalDataClear,
  type LocalDataWriteLease,
} from "../utils/local-data-write-gate";
import {
  applyInDictationStyleSwitch,
  applyWritingStyleSelection,
  deleteTone,
  loadTones,
  upsertTone,
  selectToneByHotkey,
  switchWritingStyleBackward,
  switchWritingStyleForward,
} from "./tone.actions";
import { seedManualStyles } from "../../test/helpers/tone-test.utils";

const { listTonesMock, setSelectedToneIdMock, setPreferencesMock } = vi.hoisted(
  () => ({
    listTonesMock: vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
    setPreferencesMock: vi.fn((prefs: unknown) => Promise.resolve(prefs)),
    setSelectedToneIdMock: vi.fn(
      (toneId: string, lease?: LocalDataWriteLease) => {
        produceAppState((draft) => {
          const user = draft.userById[LOCAL_USER_ID];
          if (user) {
            user.selectedToneId = toneId;
          }
        }, lease);
        return Promise.resolve();
      },
    ),
  }),
);

vi.mock("../repos", () => ({
  getToneRepo: () => ({
    listTones: listTonesMock,
    upsertTone: vi.fn((tone: unknown) => Promise.resolve(tone)),
    deleteTone: vi.fn(),
  }),
  getUserPreferencesRepo: () => ({
    setUserPreferences: setPreferencesMock,
    getUserPreferences: vi.fn(() => Promise.resolve(null)),
  }),
  getUserRepo: () => ({
    setMyUser: vi.fn((user: unknown) => Promise.resolve(user)),
    getMyUser: vi.fn(() => Promise.resolve(null)),
  }),
}));

vi.mock("./toast.actions", async () => ({
  runToast: (await import("../../test/helpers/toast-mock")).runToastMock,
  showToast: vi.fn(() => Promise.resolve()),
}));

vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
  }),
}));

vi.mock("./user.actions", () => ({
  activateAndSelectTone: vi.fn(),
  setSelectedToneId: (toneId: string, lease?: LocalDataWriteLease) =>
    setSelectedToneIdMock(toneId, lease),
}));

import { activateAndSelectTone } from "./user.actions";

const selectedToneId = () =>
  getAppState().userById[LOCAL_USER_ID]?.selectedToneId ?? null;

describe("writing style switch channels share one state transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedManualStyles("default");
  });

  afterEach(() => {
    vi.clearAllMocks();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it.each([false, true, undefined])(
    "persists a tone with activation option %s",
    async (activate) => {
      produceAppState((draft) => {
        draft.tones.selectedToneId = "default";
      });
      const tone = {
        ...getAppState().toneById.email,
        id: "new-style",
        isSystem: false,
      };
      await upsertTone(tone, activate === undefined ? undefined : { activate });
      expect(getAppState().toneById[tone.id]).toEqual(tone);
      if (activate === false) {
        expect(activateAndSelectTone).not.toHaveBeenCalled();
        expect(selectedToneId()).toBe("default");
        expect(getAppState().tones.selectedToneId).toBe("default");
      } else {
        expect(activateAndSelectTone).toHaveBeenCalledWith(
          tone.id,
          expect.any(Object),
        );
        expect(getAppState().tones.selectedToneId).toBe(tone.id);
      }
    },
  );

  it.each(["email", "chat"])(
    "deletion closes only the editor owned by %s",
    async (editingId) => {
      produceAppState((draft) => {
        draft.toneById.email.isSystem = false;
        draft.toneEditor = {
          open: true,
          mode: "edit",
          toneId: editingId,
          targetId: null,
        };
      });
      await deleteTone("email");
      expect(getAppState().toneById.email).toBeUndefined();
      expect(getAppState().toneEditor.open).toBe(editingId !== "email");
      expect(getAppState().toneEditor.toneId).toBe(editingId);
    },
  );

  it.each([null, "chat"])(
    "does not rewrite preferences when deleting an unrelated style with active tone %s",
    async (activeToneId) => {
      produceAppState((draft) => {
        draft.userPrefs = { activeToneId } as NonNullable<
          typeof draft.userPrefs
        >;
      });
      await deleteTone("email");
      expect(setPreferencesMock).not.toHaveBeenCalled();
      expect(getAppState().userPrefs?.activeToneId).toBe(activeToneId);
    },
  );

  it("persists the cleared default when deleting the active style", async () => {
    produceAppState((draft) => {
      draft.userPrefs = { activeToneId: "email" } as NonNullable<
        typeof draft.userPrefs
      >;
    });
    await deleteTone("email");
    expect(getAppState().userPrefs?.activeToneId).toBeNull();
    expect(setPreferencesMock).toHaveBeenCalledOnce();
    expect(setPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ activeToneId: null }),
      expect.any(Object),
    );
  });

  it("reports partial success if clearing the deleted default cannot be persisted", async () => {
    produceAppState((draft) => {
      draft.userPrefs = { activeToneId: "email" } as NonNullable<
        typeof draft.userPrefs
      >;
    });
    setPreferencesMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await expect(deleteTone("email")).resolves.toBeUndefined();
      expect(getAppState().toneById.email).toBeUndefined();
      expect(getAppState().userPrefs?.activeToneId).toBeNull();
      expect(getAppState().snackbarMode).toBe("error");
      expect(getAppState().snackbarMessage).toContain(
        "Style deleted, but its default setting could not be saved",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("applyWritingStyleSelection writes selectedToneId", async () => {
    await applyWritingStyleSelection("email");
    expect(selectedToneId()).toBe("email");
    expect(setSelectedToneIdMock).toHaveBeenCalledWith(
      "email",
      expect.any(Object),
    );
  });

  it("pill forward, arrow forward, and cycle-hotkey forward all land on the next style", async () => {
    await applyInDictationStyleSwitch({ channel: "pill", direction: 1 });
    expect(selectedToneId()).toBe("email");

    await applyInDictationStyleSwitch({ channel: "arrows", direction: 1 });
    expect(selectedToneId()).toBe("chat");

    await applyInDictationStyleSwitch({
      channel: "cycle-hotkey",
      direction: 1,
    });
    expect(selectedToneId()).toBe("default");
  });

  it("a style-select hotkey writes the same selectedToneId slot", async () => {
    await applyInDictationStyleSwitch({ channel: "hotkey", toneId: "chat" });
    expect(selectedToneId()).toBe("chat");
  });

  it("named cycle/select helpers are aliases of the shared transition", async () => {
    await switchWritingStyleForward();
    expect(selectedToneId()).toBe("email");

    await switchWritingStyleBackward();
    expect(selectedToneId()).toBe("default");

    await selectToneByHotkey("chat");
    expect(selectedToneId()).toBe("chat");
  });

  it("applies the in-memory selection before the persist promise settles", async () => {
    let resolvePersist!: () => void;
    setSelectedToneIdMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePersist = resolve;
      }),
    );
    const pending = applyInDictationStyleSwitch({
      channel: "hotkey",
      toneId: "chat",
    });
    expect(selectedToneId()).toBe("chat");
    expect(pending).toBeInstanceOf(Promise);
    // Release the deferred persist promise after verifying the synchronous
    // in-memory update so the write lease does not leak into later tests.
    resolvePersist();
    await pending;
  });

  it("skips persist when there is no user so in-memory and disk stay aligned", async () => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    await applyInDictationStyleSwitch({ channel: "hotkey", toneId: "chat" });
    expect(setSelectedToneIdMock).not.toHaveBeenCalled();
    expect(selectedToneId()).toBeNull();
  });

  it("restores the previous selection when persistence fails", async () => {
    setSelectedToneIdMock.mockRejectedValueOnce(new Error("sqlite down"));
    await applyWritingStyleSelection("email");
    expect(selectedToneId()).toBe("email");
  });

  it("drops stale tones when local data is cleared while listTones is in flight", async () => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    let resolveList!: (tones: unknown[]) => void;
    listTonesMock.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveList = resolve;
        }),
    );

    const loading = loadTones();
    const releaseClear = await beginLocalDataClear();
    releaseClear();

    resolveList([
      {
        id: "stale-tone",
        name: "Stale Tone",
        promptTemplate: "Keep concise",
        isSystem: false,
        sortOrder: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await loading;

    expect(getAppState().toneById["stale-tone"]).toBeUndefined();
  });
});
