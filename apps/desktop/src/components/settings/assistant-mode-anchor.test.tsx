// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The settings surface reads the platform to decide which rows it may show.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { theme } from "../../theme";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState, useAppStore } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import en from "../../i18n/locales/en.json";
import HelpPage from "../help/HelpPage";
import AiModelsSettingsPage from "./pages/AiModelsSettingsPage";
import { SettingsLayout } from "./SettingsLayout";

ensureUiHarness();

/**
 * The two halves of issue #355, in one tree.
 *
 * The Help action's label and destination are covered by
 * `HelpPage.actions.test.tsx`. What that file cannot show is that the address
 * it builds is a real row on a real page: a link can be spelled correctly and
 * still land on a page that renders no such anchor. So this renders the same
 * Help page beside the real settings shell and the real AI models page, clicks
 * the action for a person whose assistant mode is off, and expects the
 * Assistant mode row to be there, highlighted, and reachable by keyboard.
 */
describe("Help's assistant action arrives at the setting", () => {
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
            createElement(
              MemoryRouter,
              { initialEntries: ["/dashboard/help"] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: "/dashboard/help",
                  element: createElement(HelpPage),
                }),
                // A marker for the route the action used to open, so the
                // assertion below is about where the click went rather than
                // about what happens to be rendered.
                createElement(Route, {
                  path: "/dashboard/chats",
                  element: createElement("div", { id: "chats-page" }),
                }),
                createElement(
                  Route,
                  {
                    path: "/dashboard/settings",
                    element: createElement(SettingsLayout),
                  },
                  createElement(Route, {
                    path: ":page",
                    element: createElement(AiModelsSettingsPage),
                  }),
                ),
              ),
            ),
          ),
        ),
      );
    });
  };

  const assistantAction = (): HTMLButtonElement => {
    const frame = [
      ...container.querySelectorAll('[data-tip-frame="true"]'),
    ].find((element) =>
      element.textContent?.startsWith("Talk to the assistant"),
    );
    return requireElement(
      frame?.querySelector<HTMLButtonElement>("button"),
      "the assistant tip action",
    );
  };

  /** jsdom does not lay anything out, so the anchor's scroll is stubbed. */
  const flushFrames = async () => {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  };

  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("lands on the Assistant mode row of the AI models page", async () => {
    await render();

    await act(async () => assistantAction().click());
    await flushFrames();

    const row = requireElement(
      document.getElementById("setting-assistant_mode"),
      "the Assistant mode row",
    );
    expect(row.textContent).toContain("Assistant mode");
    // The layout scrolls the row into view and outlines it for a moment, so
    // the arrival is visible rather than a page that happens to be open. An
    // anchor that resolves to a row the layout never marked would be a link
    // that lands silently.
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    // The highlight is a 2px outline inset by 4px, read the way the row's own
    // suite reads it.
    expect(getComputedStyle(row).outlineOffset).toBe("-4px");
    // Arriving by keyboard should land on the control, not just the page. The
    // anchor focuses the row's switch once the Help button that was clicked has
    // gone with the route.
    expect(row.contains(document.activeElement)).toBe(true);
  });

  it("never renders the chat page for a person who cannot use it", async () => {
    await render();

    await act(async () => assistantAction().click());
    await flushFrames();

    // The chat route is a real address either way, so the defect is that the
    // action used to go there. The guard is the absence of that page, not the
    // absence of the string in an href.
    expect(container.querySelector("#chats-page")).toBeNull();
    expect(container.querySelector("#setting-assistant_mode")).not.toBeNull();
    expect(useAppStore.getState().local.assistantModeEnabled).toBe(false);
  });
});
