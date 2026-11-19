// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { DictationLanguageDialog } from "./DictationLanguageDialog";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

ensureUiHarness();
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

describe("dialog widths", () => {
  it.each([
    [
      "diagnosticsDialogOpen",
      DiagnosticsDialog,
      "minWidth",
      "min(400px, 100%)",
    ],
    ["dictationLanguageDialogOpen", DictationLanguageDialog, "width", "480px"],
  ] as const)(
    "constrains %s to its available width",
    (key, Component, property, expected) => {
      setAppState(structuredClone(INITIAL_APP_STATE), true);
      produceAppState((draft) => {
        draft.settings[key] = true;
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
              createElement(Component),
            ),
          ),
        );
        const content = document.querySelector<HTMLElement>(
          '[role="dialog"] .MuiDialogContent-root',
        );
        expect(content).not.toBeNull();
        const element =
          key === "dictationLanguageDialogOpen"
            ? document.querySelector<HTMLElement>('[role="dialog"]')
            : content;
        expect(element).not.toBeNull();
        expect(getComputedStyle(element!)[property]).toBe(expected);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
});
