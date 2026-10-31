// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

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
import { produceAppState, setAppState } from "../../store";
import { DictationLanguageDialog } from "./DictationLanguageDialog";

ensureUiHarness();
it("names each language selector, shortcut recorder, and remove action", () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  produceAppState((draft) => {
    draft.settings.dictationLanguageDialogOpen = true;
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
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
    const add = requireElement(
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Add language",
      ),
      "add language",
    );
    act(() => add.click());
    for (const number of [1, 2]) {
      expect(
        document.querySelector(
          `[role="combobox"][aria-label="Language ${number}"]`,
        ),
      ).not.toBeNull();
      const hotkey = requireElement(
        document.querySelector(
          `[role="group"][aria-label="Hotkey for language ${number}"]`,
        ),
        "named shortcut",
      );
      expect(
        document.getElementById(hotkey.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toBeTruthy();
      expect(
        document.querySelector(
          `button[aria-label="Remove language ${number}"]`,
        ),
      ).not.toBeNull();
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
