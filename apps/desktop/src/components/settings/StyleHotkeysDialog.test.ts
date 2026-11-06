// @vitest-environment jsdom
import type { ApiKey, Tone } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState, useAppStore } from "../../store";

const { replaceStyleHotkeys, load, ensure, showError } = vi.hoisted(() => ({
  replaceStyleHotkeys: vi.fn(),
  load: vi.fn(),
  ensure: vi.fn(),
  showError: vi.fn(),
}));
vi.mock("../../actions/hotkey.actions", () => ({
  loadHotkeys: load,
  ensureHotkeysLoaded: ensure,
}));
vi.mock("../../actions/app.actions", () => ({ showErrorSnackbar: showError }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({ replaceStyleHotkeys }),
}));

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});

import { StyleHotkeysDialog } from "./StyleHotkeysDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const tone: Tone = {
  id: "tone-1",
  name: "Meeting notes",
  promptTemplate: "Use concise meeting notes.",
  isSystem: false,
  createdAt: 1,
  sortOrder: 0,
};

const postProcessingKey: ApiKey = {
  id: "post-processing-key",
  name: "Post-processing",
  provider: "groq",
  createdAt: "2026-08-19T00:00:00.000Z",
  keyFull: "secret",
};

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const setPostProcessingEnabled = (enabled: boolean) => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = enabled ? "api" : "none";
    draft.settings.aiPostProcessing.selectedApiKeyId = enabled
      ? postProcessingKey.id
      : null;
    if (enabled) {
      draft.apiKeyById[postProcessingKey.id] = postProcessingKey;
    }
  });
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label,
  );

const findEditableHotkey = (): HTMLDivElement | undefined =>
  [...document.body.querySelectorAll<HTMLDivElement>('div[tabindex="0"]')].find(
    (element) => element.textContent?.trim() === "Set hotkey",
  );

describe("StyleHotkeysDialog post-processing gate", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    resetState();
    replaceStyleHotkeys.mockReset().mockResolvedValue([]);
    load.mockReset().mockResolvedValue(undefined);
    ensure.mockReset().mockResolvedValue(true);
    showError.mockReset();
    produceAppState((draft) => {
      draft.settings.styleHotkeysDialogOpen = true;
      draft.settings.hotkeysStatus = "success";
      draft.toneById[tone.id] = tone;
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    resetState();
  });

  const renderDialog = async () => {
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(StyleHotkeysDialog));
    });
  };

  it("admits only one same-turn save and cannot close while it is pending", async () => {
    let finish!: (value: []) => void;
    replaceStyleHotkeys.mockReturnValue(
      new Promise<[]>((resolve) => {
        finish = resolve;
      }),
    );
    await renderDialog();
    const save = findButton("Save")!;
    const cancel = findButton("Cancel")!;
    act(() => {
      save.click();
      save.click();
      cancel.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(replaceStyleHotkeys).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
    await act(async () => {
      finish([]);
      await Promise.resolve();
    });
  });

  it("waits for hydration and retries failed loads", async () => {
    ensure.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await renderDialog();
    expect(findButton("Save")?.disabled).toBe(true);
    await act(async () => findButton("Retry")?.click());
    expect(findButton("Save")?.disabled).toBe(false);
  });

  it("snapshots loaded shortcuts and sends them to the replacement", async () => {
    let finish!: (value: boolean) => void;
    ensure.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    await renderDialog();
    expect(findButton("Save")?.disabled).toBe(true);
    const existing = {
      id: "style-old",
      actionName: "switch-to-style:tone-1",
      keys: ["Alt", "S"],
    };
    await act(async () =>
      produceAppState((state) => {
        state.hotkeyById[existing.id] = existing;
        state.settings.hotkeyIds.push(existing.id);
      }),
    );
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    await act(async () => findButton("Save")?.click());
    expect(replaceStyleHotkeys).toHaveBeenCalledWith(
      "switch-to-style:",
      [existing],
      [existing],
    );
  });

  it("sends an empty replacement when every style shortcut is cleared", async () => {
    // The dialog owns the only UI for removing style shortcuts, so clearing
    // the last row has to reach the replacement as an empty set. Skipping the
    // call would leave the persisted shortcut behind and the row would come
    // back on the next load.
    const existing = {
      id: "style-old",
      actionName: "switch-to-style:tone-1",
      keys: ["Alt", "S"],
    };
    produceAppState((state) => {
      state.hotkeyById[existing.id] = existing;
      state.settings.hotkeyIds.push(existing.id);
    });
    await renderDialog();
    const clear = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear style hotkey"]',
    );
    expect(clear).toBeTruthy();
    await act(async () => clear?.click());
    expect(
      document.body.querySelector('button[aria-label="Clear style hotkey"]'),
    ).toBeNull();
    await act(async () => findButton("Save")?.click());
    expect(replaceStyleHotkeys).toHaveBeenCalledWith(
      "switch-to-style:",
      [],
      [existing],
    );
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(false);
  });

  it("retries with the committed snapshot after a refresh failure", async () => {
    const existing = {
      id: "style-old",
      actionName: "switch-to-style:tone-1",
      keys: ["Alt", "S"],
    };
    produceAppState((state) => {
      state.hotkeyById[existing.id] = existing;
      state.settings.hotkeyIds.push(existing.id);
    });
    replaceStyleHotkeys.mockImplementation(async (_prefix, hotkeys) => hotkeys);
    load
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        produceAppState((state) => {
          state.settings.hotkeysStatus = "error";
        });
      })
      .mockImplementationOnce(async () => {
        produceAppState((state) => {
          state.settings.hotkeysStatus = "success";
        });
      });
    await renderDialog();
    await act(async () => findButton("Save")?.click());
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
    const saved = replaceStyleHotkeys.mock.calls[0][1];
    await act(async () => findButton("Save")?.click());
    expect(replaceStyleHotkeys.mock.calls[1][2]).toEqual(saved);
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(false);
  });

  it("reports stale snapshots without closing or refreshing", async () => {
    replaceStyleHotkeys.mockRejectedValueOnce("STYLE_HOTKEYS_CHANGED");
    await renderDialog();
    await act(async () => findButton("Save")?.click());
    expect(showError).toHaveBeenCalledWith(
      "Shortcuts changed elsewhere. Reopen this dialog and try again.",
    );
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not close a reopened dialog when an earlier save completes", async () => {
    let finish!: (value: []) => void;
    replaceStyleHotkeys.mockReturnValueOnce(
      new Promise<[]>((resolve) => {
        finish = resolve;
      }),
    );
    await renderDialog();
    await act(async () => {
      findButton("Save")?.click();
      await Promise.resolve();
    });
    await act(async () =>
      produceAppState((state) => {
        state.settings.styleHotkeysDialogOpen = false;
      }),
    );
    await act(async () =>
      produceAppState((state) => {
        state.settings.styleHotkeysDialogOpen = true;
      }),
    );
    await act(async () => {
      finish([]);
      await Promise.resolve();
    });
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
  });

  it("does not apply an old save to a different auth session", async () => {
    let finish!: (value: []) => void;
    replaceStyleHotkeys.mockReturnValueOnce(
      new Promise<[]>((resolve) => {
        finish = resolve;
      }),
    );
    await renderDialog();
    await act(async () => {
      findButton("Save")?.click();
      await Promise.resolve();
    });
    await act(async () =>
      produceAppState((state) => {
        state.authSessionNonce++;
      }),
    );
    const loadsAfterSessionChange = load.mock.calls.length;
    await act(async () => {
      finish([]);
      await Promise.resolve();
    });
    expect(useAppStore.getState().settings.styleHotkeysDialogOpen).toBe(true);
    expect(load).toHaveBeenCalledTimes(loadsAfterSessionChange);
  });

  it("keeps hotkey rows functional even when LLM post-processing is off (fast path)", async () => {
    setPostProcessingEnabled(false);
    await renderDialog();

    // Fast local styling keeps hotkeys usable
    expect(findEditableHotkey()).toBeDefined();
    expect(findButton("Save")?.disabled).toBe(false);
  });

  it("keeps hotkey editing available when post-processing is configured", async () => {
    setPostProcessingEnabled(true);
    await renderDialog();

    expect(findEditableHotkey()).toBeDefined();
    expect(findButton("Save")?.disabled).toBe(false);
  });

  it("keeps rows enabled when post-processing is turned off (fast path)", async () => {
    setPostProcessingEnabled(true);
    await renderDialog();
    expect(findEditableHotkey()).toBeDefined();

    act(() => setPostProcessingEnabled(false));

    expect(findEditableHotkey()).toBeDefined();
    expect(findButton("Save")?.disabled).toBe(false);
  });
});
