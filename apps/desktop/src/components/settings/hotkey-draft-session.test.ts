import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState, useAppStore } from "../../store";
import type { Hotkey } from "@maus-inc/types";
import {
  createReplacementIdAllocator,
  isHotkeyDialogCurrent,
  refreshHotkeysAndClose,
  runHotkeyDraftSave,
} from "./hotkey-draft-session";

const mocks = vi.hoisted(() => ({
  loadHotkeys: vi.fn(),
  showError: vi.fn(),
}));

vi.mock("../../actions/hotkey.actions", () => ({
  loadHotkeys: mocks.loadHotkeys,
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showError,
}));

const signIn = (uid: string, nonce = 1) => {
  produceAppState((state) => {
    state.auth = {
      uid,
      email: null,
      displayName: null,
      providers: ["password"],
    };
    state.authSessionNonce = nonce;
  });
};

describe("isHotkeyDialogCurrent", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((state) => {
      state.settings.styleHotkeysDialogOpen = true;
    });
    signIn("alice");
  });

  it("requires the same revision, an open dialog and the same session", () => {
    expect(
      isHotkeyDialogCurrent("styleHotkeysDialogOpen", 2, 2, 1, "alice"),
    ).toBe(true);
    expect(
      isHotkeyDialogCurrent("styleHotkeysDialogOpen", 1, 2, 1, "alice"),
    ).toBe(false);
    expect(
      isHotkeyDialogCurrent("styleHotkeysDialogOpen", 2, 2, 1, "bob"),
    ).toBe(false);
    expect(
      isHotkeyDialogCurrent("styleHotkeysDialogOpen", 2, 2, 2, "alice"),
    ).toBe(false);
  });

  it("is false once the dialog closes", () => {
    produceAppState((state) => {
      state.settings.styleHotkeysDialogOpen = false;
    });

    expect(
      isHotkeyDialogCurrent("styleHotkeysDialogOpen", 2, 2, 1, "alice"),
    ).toBe(false);
  });

  it("does not treat a different dialog's flag as this one's", () => {
    produceAppState((state) => {
      state.settings.dictationLanguageDialogOpen = false;
    });

    expect(
      isHotkeyDialogCurrent("dictationLanguageDialogOpen", 2, 2, 1, "alice"),
    ).toBe(false);
  });
});

describe("runHotkeyDraftSave", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    mocks.showError.mockReset();
    mocks.loadHotkeys.mockReset();
  });

  it("admits one same-turn submission and always clears the flag", async () => {
    const saving = { current: false };
    const setSaving = vi.fn();
    let release!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = runHotkeyDraftSave(
      saving,
      setSaving,
      () => true,
      () => "conflict",
      operation,
    );
    const second = runHotkeyDraftSave(
      saving,
      setSaving,
      () => true,
      () => "conflict",
      operation,
    );

    expect(operation).toHaveBeenCalledTimes(1);
    expect(setSaving).toHaveBeenLastCalledWith(true);
    release();
    await Promise.all([first, second]);
    expect(saving.current).toBe(false);
    expect(setSaving).toHaveBeenLastCalledWith(false);
    expect(mocks.showError).not.toHaveBeenCalled();
  });

  it("reports a conflict with the dialog's own message", async () => {
    const saving = { current: false };

    await runHotkeyDraftSave(
      saving,
      () => undefined,
      () => true,
      () => "Shortcuts changed elsewhere.",
      () => Promise.reject(new Error("STYLE_HOTKEYS_CHANGED")),
    );

    expect(mocks.showError).toHaveBeenCalledWith(
      "Shortcuts changed elsewhere.",
    );
    expect(saving.current).toBe(false);
  });

  it("stays silent when the dialog is no longer current", async () => {
    const saving = { current: false };

    await runHotkeyDraftSave(
      saving,
      () => undefined,
      () => false,
      () => "conflict",
      () => Promise.reject(new Error("boom")),
    );

    expect(mocks.showError).not.toHaveBeenCalled();
    expect(saving.current).toBe(false);
  });
});

describe("refreshHotkeysAndClose", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    mocks.loadHotkeys.mockReset().mockResolvedValue(undefined);
    produceAppState((state) => {
      state.settings.styleHotkeysDialogOpen = true;
      state.settings.hotkeysStatus = "success";
    });
    signIn("alice");
  });

  it("reloads and closes the dialog it saved", async () => {
    await refreshHotkeysAndClose(
      "styleHotkeysDialogOpen",
      1,
      "alice",
      () => true,
    );

    expect(mocks.loadHotkeys).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(false);
  });

  it("keeps the dialog open when the reload fails", async () => {
    mocks.loadHotkeys.mockImplementation(async () => {
      produceAppState((state) => {
        state.settings.hotkeysStatus = "error";
      });
    });

    await refreshHotkeysAndClose(
      "styleHotkeysDialogOpen",
      1,
      "alice",
      () => true,
    );

    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
  });

  it("does nothing for a different auth session", async () => {
    await refreshHotkeysAndClose(
      "styleHotkeysDialogOpen",
      1,
      "bob",
      () => true,
    );

    expect(mocks.loadHotkeys).not.toHaveBeenCalled();
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
  });

  it("does not close a reopened dialog after the save went stale", async () => {
    await refreshHotkeysAndClose(
      "styleHotkeysDialogOpen",
      1,
      "alice",
      () => false,
    );

    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
  });
});

describe("createReplacementIdAllocator", () => {
  const hotkey = (id: string, actionName: string): Hotkey => ({
    id,
    actionName,
    keys: ["Control"],
  });

  it("keeps a surviving row on its own id and gives a new row a fresh one", () => {
    const nextId = createReplacementIdAllocator([
      hotkey("primary", "dictate"),
      hotkey("fr", "additional-language:fr"),
    ]);

    expect(nextId("dictate")).toBe("primary");
    expect(nextId("additional-language:fr")).toBe("fr");
    const fresh = nextId("additional-language:de");
    expect(fresh).not.toBe("primary");
    expect(fresh).not.toBe("fr");
    expect(fresh.length).toBeGreaterThan(0);
  });

  it("hands out one id per snapshot row so a repeated action never collides", () => {
    const nextId = createReplacementIdAllocator([
      hotkey("first", "dictate"),
      hotkey("second", "dictate"),
    ]);

    expect([nextId("dictate"), nextId("dictate")]).toEqual(["first", "second"]);
  });

  it("does not reuse an id after the snapshot rows are exhausted", () => {
    const nextId = createReplacementIdAllocator([hotkey("only", "dictate")]);

    expect(nextId("dictate")).toBe("only");
    expect(nextId("dictate")).not.toBe("only");
  });
});
