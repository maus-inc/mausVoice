// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("./save-dictation-language-settings", () => ({
  saveDictationLanguageSettings: mocks.save,
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
import { DictationLanguageDialog } from "./DictationLanguageDialog";

ensureUiHarness();
it("blocks duplicate saves, edits and dismissal while pending and permits retry", async () => {
  let reject!: (error: Error) => void;
  mocks.save.mockReset().mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  mocks.save.mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.dictationLanguageDialogOpen = true;
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
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
          createElement(DictationLanguageDialog),
        ),
      ),
    );
    act(() => {
      button("Save").click();
      button("Save").click();
      button("Cancel").click();
    });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
    expect(button("Save").getAttribute("aria-busy")).toBe("true");
    expect(button("Add language").disabled).toBe(true);
    expect(
      document
        .querySelector('[aria-label="Hotkey for language 1"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => {
      reject(new Error("failed"));
    });
    expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Some changes may be saved",
    );
    await act(async () => button("Save").click());
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(getAppState().settings.dictationLanguageDialogOpen).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("keeps distinct shortcuts for duplicate language rows in its save draft", async () => {
  mocks.save.mockReset().mockResolvedValue(undefined);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.dictationLanguageDialogOpen = true;
    draft.hotkeyById.a = {
      id: "a",
      actionName: "additional-language:fr",
      keys: ["KeyA"],
    };
    draft.hotkeyById.b = {
      id: "b",
      actionName: "additional-language:fr",
      keys: ["KeyB"],
    };
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(DictationLanguageDialog),
        ),
      ),
    );
    const second = requireElement(
      document.querySelector('[aria-label="Hotkey for language 2"]'),
      "second shortcut",
    );
    const third = requireElement(
      document.querySelector('[aria-label="Hotkey for language 3"]'),
      "third shortcut",
    );
    expect(second.textContent).toContain("A");
    expect(third.textContent).toContain("B");
    const save = requireElement(
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === "Save",
      ),
      "Save",
    );
    await act(async () => save.click());
    const rows = mocks.save.mock.calls[0][0];
    expect(
      rows.slice(1).map((row: { hotkeyKeys: string[] }) => row.hotkeyKeys),
    ).toEqual([["KeyA"], ["KeyB"]]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
