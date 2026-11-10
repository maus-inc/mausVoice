// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  sync: vi.fn(),
  error: vi.fn(),
  load: vi.fn(),
}));
vi.mock("../../repos", () => ({
  getHotkeyRepo: () => ({ replaceStyleHotkeys: mocks.replace }),
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
}));
vi.mock("../../actions/hotkey.actions", () => ({
  loadHotkeys: mocks.load,
}));
vi.mock("../../utils/keyboard.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/keyboard.utils")>()),
  syncHotkeyCombosToNative: mocks.sync,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, produceAppState, setAppState } from "../../store";
import { StyleHotkeysDialog } from "./StyleHotkeysDialog";

ensureUiHarness();
it("locks style shortcut edits and dismissals while replacing, then allows a failed save to be retried", async () => {
  let reject!: (error: Error) => void;
  mocks.replace.mockReset().mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  mocks.replace.mockResolvedValue([]);
  mocks.sync.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.styleHotkeysDialogOpen = true;
    draft.toneById.test = {
      id: "test",
      name: "Concise",
      sortOrder: 1,
      isDeprecated: false,
    } as (typeof draft.toneById)[string];
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (text: string) =>
    requireElement(
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === text,
      ),
      text,
    );
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(StyleHotkeysDialog),
        ),
      ),
    );
    const hotkey = requireElement(
      document.querySelector<HTMLElement>(
        '.MuiDialogContent-root div[tabindex="0"]',
      ),
      "hotkey",
    );
    expect(hotkey.getAttribute("role")).toBe("textbox");
    expect(hotkey.getAttribute("aria-label")).toBe("Shortcut for Concise");
    expect(
      document.getElementById(hotkey.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBeTruthy();
    act(() => hotkey.focus());
    expect(getAppState().isRecordingHotkey).toBe(true);
    act(() => {
      button("Save").click();
      button("Save").click();
      button("Cancel").click();
    });
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(getAppState().settings.styleHotkeysDialogOpen).toBe(true);
    expect(hotkey.getAttribute("aria-disabled")).toBe("true");
    expect(hotkey.tabIndex).toBe(-1);
    expect(button("Save").getAttribute("aria-busy")).toBe("true");
    expect(button("Save").querySelector('[role="progressbar"]')).not.toBeNull();
    expect(getAppState().isRecordingHotkey).toBe(false);
    await act(async () => {
      reject(new Error("failed"));
    });
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(hotkey.getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      button("Save").click();
    });
    expect(mocks.replace).toHaveBeenCalledTimes(2);
    expect(getAppState().settings.styleHotkeysDialogOpen).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("sends the style group it opened with, and resyncs when another window changed it", async () => {
  mocks.replace.mockReset();
  mocks.replace
    .mockRejectedValueOnce(
      new Error("error returned from database: STYLE_HOTKEYS_CHANGED"),
    )
    .mockResolvedValueOnce([]);
  mocks.sync.mockReset().mockResolvedValue(undefined);
  mocks.error.mockReset();
  mocks.load.mockReset().mockImplementation(async () => {
    produceAppState((draft) => {
      draft.hotkeyById.existing.keys = ["Cmd", "2"];
      draft.hotkeyById.unrelated = {
        id: "unrelated",
        actionName: "toggle-recording",
        keys: ["Cmd", "3"],
      } as (typeof draft.hotkeyById)[string];
    });
  });
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.styleHotkeysDialogOpen = true;
    draft.toneById.test = {
      id: "test",
      name: "Concise",
      sortOrder: 1,
      isDeprecated: false,
    } as (typeof draft.toneById)[string];
    draft.hotkeyById.existing = {
      id: "existing",
      actionName: "switch-to-style:other",
      keys: ["Cmd", "1"],
    } as (typeof draft.hotkeyById)[string];
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (text: string) =>
    requireElement(
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === text,
      ),
      text,
    );
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(StyleHotkeysDialog),
        ),
      ),
    );
    await act(async () => {
      button("Save").click();
    });
    // The group the dialog rendered with travels with the replacement, so
    // native can refuse to delete a shortcut another window just saved.
    expect(mocks.replace).toHaveBeenCalledWith(
      "switch-to-style:",
      expect.any(Array),
      undefined,
      [
        {
          id: "existing",
          actionName: "switch-to-style:other",
          keys: ["Cmd", "1"],
        },
      ],
    );
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(getAppState().settings.styleHotkeysDialogOpen).toBe(true);
    await act(async () => {
      button("Save").click();
    });
    expect(mocks.replace).toHaveBeenLastCalledWith(
      "switch-to-style:",
      expect.any(Array),
      undefined,
      [
        {
          id: "existing",
          actionName: "switch-to-style:other",
          keys: ["Cmd", "2"],
        },
      ],
    );
    expect(getAppState().settings.styleHotkeysDialogOpen).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
