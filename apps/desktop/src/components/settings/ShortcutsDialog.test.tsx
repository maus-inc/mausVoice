// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../hooks/tauri.hooks", () => ({ useTauriListen: () => {} }));

// The dialog's key rows read the platform to show its default combos.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));

import { theme } from "../../theme";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import en from "../../i18n/locales/en.json";
import { ShortcutsDialog } from "./ShortcutsDialog";

ensureUiHarness();

/**
 * The dialog lists the assistant keys whether or not Assistant mode is on, and
 * says what pressing one does in that state. The Help page's dead-end action
 * was the same defect in a card (issue #355): a control that promised an
 * assistant feature the person had not enabled. Here the promise is words, so
 * the words are what the test reads.
 */
describe("ShortcutsDialog assistant rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { theme },
          createElement(
            IntlProvider,
            { locale: "en", messages: en },
            createElement(ShortcutsDialog),
          ),
        ),
      );
    });
  };

  const dialogText = () =>
    requireElement(document.querySelector('[role="dialog"]'), "the dialog")
      .textContent ?? "";

  const setAssistantMode = (enabled: boolean) =>
    act(() => {
      setAppState((state) => ({
        ...state,
        local: { ...state.local, assistantModeEnabled: enabled },
      }));
    });

  beforeEach(() => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.shortcutsDialogOpen = true;
    state.settings.hotkeysStatus = "success";
    setAppState(state, true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("explains what an assistant key does while the feature is off", async () => {
    await render();

    expect(dialogText()).toContain("Assistant mode");
    expect(dialogText()).toContain("Turn on Assistant mode to use this key.");
    expect(dialogText()).toContain(
      "Turn on Assistant mode to open a conversation.",
    );
  });

  it("describes the real behaviour while the feature is on", async () => {
    setAssistantMode(true);
    await render();

    expect(dialogText()).toContain(
      "Dictate commands for the AI to follow instead of just cleaning up text.",
    );
    expect(dialogText()).toContain(
      "Open the current assistant conversation in the main window.",
    );
    expect(dialogText()).not.toContain("Turn on Assistant mode");
  });

  it("keeps every assistant key listed in both states", async () => {
    await render();
    const count = (needle: string) => dialogText().split(needle).length - 1;
    // "Open chat" appears in its own title and nowhere else, so its count is
    // the row count. The hint in the off state adds two mentions of the
    // feature's name, which is why the title is counted this way.
    expect(count("Open chat")).toBe(1);
    expect(count("Assistant mode")).toBeGreaterThanOrEqual(1);

    act(() => {
      setAppState((state) => ({
        ...state,
        local: { ...state.local, assistantModeEnabled: true },
      }));
    });

    expect(count("Open chat")).toBe(1);
    expect(count("Assistant mode")).toBeGreaterThanOrEqual(1);
  });
});
