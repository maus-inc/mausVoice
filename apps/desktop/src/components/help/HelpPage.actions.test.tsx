// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { theme } from "../../theme";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import en from "../../i18n/locales/en.json";
import HelpPage from "./HelpPage";

ensureUiHarness();

const LocationProbe = () => {
  const location = useLocation();
  return createElement(
    "output",
    { id: "location" },
    `${location.pathname}${location.hash}`,
  );
};

/**
 * The Help listing shows every tip, including the one for a feature that is
 * off. What it must not do is send someone into that feature anyway: with
 * assistant mode off the route has no rail entry and nothing works on it, so
 * the action belongs on the setting that turns the feature on. Issue #355.
 */
describe("HelpPage tip actions", () => {
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
                  path: "*",
                  element: createElement(
                    "div",
                    null,
                    createElement(HelpPage),
                    createElement(LocationProbe),
                  ),
                }),
              ),
            ),
          ),
        ),
      );
    });
  };

  const setAssistantMode = (enabled: boolean) =>
    act(() => {
      setAppState((state) => ({
        ...state,
        local: { ...state.local, assistantModeEnabled: enabled },
      }));
    });

  /** The action button inside the card whose heading starts with `title`. */
  const actionFor = (title: string): HTMLButtonElement => {
    const frame = [
      ...container.querySelectorAll('[data-tip-frame="true"]'),
    ].find((element) => element.textContent?.startsWith(title));
    return requireElement(
      frame?.querySelector<HTMLButtonElement>("button"),
      `the ${title} action`,
    );
  };

  const location = () =>
    requireElement(container.querySelector("#location"), "the location probe")
      .textContent;

  const click = async (button: HTMLButtonElement) => {
    await act(async () => button.click());
  };

  beforeEach(() => {
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

  it("opens the chat route while assistant mode is on", async () => {
    setAssistantMode(true);
    await render();

    const action = actionFor("Talk to the assistant");
    expect(action.textContent).toBe("Open chat");
    await click(action);

    expect(location()).toBe("/dashboard/chats");
  });

  it("opens the assistant mode setting while the feature is off", async () => {
    await render();

    const action = actionFor("Talk to the assistant");
    // The label names the destination the click reaches, which is the settings
    // row rather than the chat page.
    expect(action.textContent).toBe("Open settings");
    await click(action);

    expect(location()).toBe(
      "/dashboard/settings/ai-models#setting-assistant_mode",
    );
  });

  it("follows the switch while the page is open", async () => {
    await render();
    expect(actionFor("Talk to the assistant").textContent).toBe(
      "Open settings",
    );

    // Turning the feature on and coming back to Help is the acceptance
    // criterion, and it is the same mounted page: the label and the
    // destination both follow the store.
    setAssistantMode(true);
    expect(actionFor("Talk to the assistant").textContent).toBe("Open chat");
    await click(actionFor("Talk to the assistant"));
    expect(location()).toBe("/dashboard/chats");
  });

  it("keeps the other tips on their own destinations", async () => {
    await render();

    await click(actionFor("Teach mausVoice how you write"));
    expect(location()).toBe("/dashboard/styling");

    await click(actionFor("Review before it inserts"));
    expect(location()).toBe("/dashboard/transcriptions");
  });
});
