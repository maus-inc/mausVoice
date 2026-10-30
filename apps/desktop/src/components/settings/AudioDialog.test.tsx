// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { AudioDialog } from "./AudioDialog";

ensureUiHarness();

afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

describe("AudioDialog", () => {
  it("associates the interaction feedback switch with its title and description", () => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    produceAppState((draft) => {
      draft.settings.audioDialogOpen = true;
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
            createElement(AudioDialog),
          ),
        ),
      );
      const input = document.querySelector<HTMLInputElement>(
        '[role="dialog"] input[type="checkbox"]',
      );
      expect(
        document
          .querySelector('[aria-label="Pill click volume"]')
          ?.getAttribute("aria-valuetext"),
      ).toBe("35%");
      expect(
        document
          .querySelector('[aria-label="Dictation audio dim level"]')
          ?.getAttribute("aria-valuetext"),
      ).toBe("100%");
      expect(input).not.toBeNull();
      const content = document.querySelector<HTMLElement>(
        '[role="dialog"] .MuiDialogContent-root',
      );
      expect(content && getComputedStyle(content).minWidth).toBe(
        "min(360px, 100%)",
      );
      expect(
        document.getElementById(input?.getAttribute("aria-labelledby") ?? "")
          ?.textContent,
      ).toBe("Interaction feedback");
      expect(
        document.getElementById(input?.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toContain("Play a short haptic-style click");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
