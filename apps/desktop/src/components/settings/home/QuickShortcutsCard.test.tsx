// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "@mui/material";
import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../../state/app.state";
import { setAppState } from "../../../store";
import { theme } from "../../../theme";
import en from "../../../i18n/locales/en.json";
import { DICTATE_HOTKEY } from "../../../utils/keyboard.utils";
import { QuickShortcutsCard } from "./QuickShortcutsCard";

const loadHotkeys = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../actions/hotkey.actions", () => ({ loadHotkeys }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
ensureUiHarness();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = () =>
  act(() =>
    root.render(
      createElement(
        ThemeProvider,
        { theme },
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(MemoryRouter, null, createElement(QuickShortcutsCard)),
        ),
      ),
    ),
  );
const row = () =>
  Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Hold to dictate"),
  );

it("does not report a default while bindings load or after load failure", () => {
  render();
  expect(container.textContent).toContain("Loading");
  expect(row()).toBeUndefined();
  act(() =>
    setAppState((state) => ({
      ...state,
      settings: { ...state.settings, hotkeysStatus: "error" },
    })),
  );
  expect(container.textContent).toContain("Could not load shortcuts");
  expect(row()).toBeUndefined();
  const retry = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Try again",
  );
  expect(retry).toBeDefined();
  act(() => retry?.click());
  expect(loadHotkeys).toHaveBeenCalledOnce();
});
it("shows the configured primary including an explicit empty binding", () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings.hotkeysStatus = "success";
  state.settings.hotkeyIds = ["primary", "extra"];
  state.hotkeyById = {
    primary: { id: "primary", actionName: DICTATE_HOTKEY, keys: [] },
    extra: { id: "extra", actionName: DICTATE_HOTKEY, keys: ["KeyA"] },
  };
  setAppState(state, true);
  render();
  expect(row()?.textContent).toContain("Not set");
  act(() =>
    setAppState((previous) => ({
      ...previous,
      hotkeyById: {
        ...previous.hotkeyById,
        primary: { ...previous.hotkeyById.primary, keys: ["KeyB"] },
      },
    })),
  );
  expect(row()?.textContent).toContain("B");
});
