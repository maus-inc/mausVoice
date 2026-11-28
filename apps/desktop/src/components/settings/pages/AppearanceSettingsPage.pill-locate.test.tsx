// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPillLocateGestureModifier: vi.fn((_modifier: string) => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../../actions/user.actions", () => ({
  setDictationPillVisibility: vi.fn(() => Promise.resolve()),
  setMenuBarIconHidden: vi.fn(() => Promise.resolve()),
  setPillLocateGestureModifier: (modifier: string) =>
    mocks.setPillLocateGestureModifier(modifier),
  setPillResetMonitorStrategy: vi.fn(() => Promise.resolve()),
}));

import {
  INITIAL_APP_STATE,
  type KeyboardListenerHealth,
} from "../../../state/app.state";
import { setAppState } from "../../../store";
import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../../test/helpers/dom";
import en from "../../../i18n/locales/en.json";
import AppearanceSettingsPage from "./AppearanceSettingsPage";

ensureUiHarness();

const KEY = "show_pill_position_with_modifier_double_tap";

const prefs = {
  dictationPillVisibility: "while_active",
  pillResetMonitorStrategy: "current",
  pillLocateGestureModifier: "none",
  menuBarIconHidden: false,
};

describe("AppearanceSettingsPage pill locate row", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            MemoryRouter,
            { initialEntries: ["/dashboard/settings/appearance"] },
            createElement(AppearanceSettingsPage),
          ),
        ),
      );
    });

  const setState = (
    hotkeyStrategy: "listener" | "bridge",
    keyboardListenerHealth: KeyboardListenerHealth = "healthy_grab",
  ) =>
    setAppState(
      {
        ...structuredClone(INITIAL_APP_STATE),
        hotkeyStrategy,
        keyboardListenerHealth,
        userPrefs: prefs as typeof INITIAL_APP_STATE.userPrefs,
      },
      true,
    );

  const row = () => document.getElementById(`setting-${KEY}`);

  beforeEach(() => {
    mocks.setPillLocateGestureModifier.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setState("listener");
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers Disabled, Alt, Shift and Control and saves the selected one", () => {
    const section = requireElement(row(), "the pill locate row");
    const select = requireElement(
      section.querySelector<HTMLElement>("[role='combobox']"),
      "the modifier dropdown",
    );
    expect(select.textContent).toContain("Disabled");

    act(() => {
      select.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    const options = [...document.querySelectorAll("[role='option']")];
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "Disabled",
      "Alt",
      "Shift",
      "Control",
    ]);

    const alt = options.find(
      (option) => option.getAttribute("aria-label") === "Alt",
    );
    act(() => {
      requireElement(alt, "the Alt option").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(mocks.setPillLocateGestureModifier).toHaveBeenCalledWith("alt");
  });

  it("is absent when the listener strategy is unavailable", () => {
    act(() => setState("bridge"));
    render();
    expect(row()).toBeNull();
  });

  it("is absent while the listener is not delivering keys", () => {
    act(() => setState("listener", "grab_failed"));
    render();
    expect(row()).toBeNull();
  });

  it("is offered on a listener platform while the listener is live", () => {
    // Windows, macOS and Linux X11 all report the listener strategy, so this is
    // the Windows configuration: a strategy of `listener` with a listener that
    // is publishing snapshots. `connected` and `fallback_starting` are the two
    // live states before the grace window proves the path alive, and Windows
    // passes through both after every wake, unlock and elevation relaunch.
    for (const health of [
      "connected",
      "healthy_grab",
      "fallback_starting",
      "degraded_listen_fallback",
    ] as const) {
      act(() => setState("listener", health));
      render();
      expect({ health, visible: row() !== null }).toEqual({
        health,
        visible: true,
      });
    }
  });

  it("is absent when the listener has stopped publishing snapshots", () => {
    // Offering the dropdown here would promise a gesture nothing is listening
    // for, so every state without a publishing listener keeps the row out.
    for (const health of [
      "starting",
      "grab_failed",
      "failed",
      "stopped",
    ] as const) {
      act(() => setState("listener", health));
      render();
      expect({ health, visible: row() !== null }).toEqual({
        health,
        visible: false,
      });
    }
  });

  it("is absent until the listener reports its health", () => {
    act(() => setState("listener", "stopped"));
    render();
    expect(row()).toBeNull();
  });
});
