// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn(), error: vi.fn() }));
vi.mock("./save-dictation-language-settings", () => ({
  saveDictationLanguageSettings: mocks.save,
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
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
  mocks.error.mockReset();
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
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(getAppState().settings.dictationLanguageDialogOpen).toBe(true);
    await act(async () => button("Save").click());
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(getAppState().settings.dictationLanguageDialogOpen).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
