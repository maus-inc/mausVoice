// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no Tauri platform, and the surface reads it to decide which rows
// the rail's pages may show.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import en from "../../i18n/locales/en.json";
import { LAST_SETTINGS_PAGE_STORAGE_KEY } from "../../utils/local-storage.utils";
import { SettingsEntryRedirect, SettingsLayout } from "./SettingsLayout";

ensureUiHarness();

/**
 * The settings surface is a shell around routed pages, so what matters here is
 * the shell's own behaviour: which page it says you are on, what a deep link
 * does, and what the search box does with the keyboard. Each page's rows are
 * covered by the registry and route tests.
 */
describe("SettingsLayout", () => {
  let container: HTMLDivElement;
  let root: Root;

  // Async because the bare-path case renders a redirect, and react-router
  // commits that navigation in an effect: awaiting the act flushes it.
  const render = async (path: string) => {
    await act(async () => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(
              Routes,
              null,
              createElement(
                Route,
                {
                  path: "/dashboard/settings",
                  element: createElement(SettingsLayout),
                },
                // The same shape the router builds: an index redirect for the
                // bare path, one page route per registry page, and a catch-all
                // that resolves unknown page names the same way.
                createElement(Route, {
                  index: true,
                  element: createElement(SettingsEntryRedirect),
                }),
                createElement(Route, {
                  path: ":page",
                  element: createElement("div", null),
                }),
              ),
            ),
          ),
        ),
      );
    });
  };

  const searchInput = () => container.querySelector<HTMLInputElement>("input");

  const setQuery = (value: string) => {
    const input = searchInput();
    if (!input) {
      throw new Error("Expected the search field to be rendered");
    }
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };

  const press = (key: string, init: KeyboardEventInit = {}) => {
    const input = searchInput();
    if (!input) {
      throw new Error("Expected the search field to be rendered");
    }
    act(() => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key, bubbles: true, ...init }),
      );
    });
  };

  const railCurrent = () =>
    container.querySelector('[aria-current="page"]')?.textContent ?? null;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the page you are on in the rail", async () => {
    await render("/dashboard/settings/account");

    expect(railCurrent()).toBe("Account");
  });

  it("names the page you are on and describes it", async () => {
    await render("/dashboard/settings/privacy-data");

    expect(container.textContent).toContain("Privacy and data");
  });

  it("reopens the page the settings routes remembered", async () => {
    window.localStorage.setItem(LAST_SETTINGS_PAGE_STORAGE_KEY, "shortcuts");

    // The redirect that resolves the bare path reads the remembered page, so
    // the rail has to be showing it too.
    await render("/dashboard/settings");
    expect(railCurrent()).toBe("Shortcuts");
  });

  it("says where a deep link landed by remembering its page", async () => {
    await render("/dashboard/settings/system#setting-update_channel");

    expect(window.localStorage.getItem(LAST_SETTINGS_PAGE_STORAGE_KEY)).toBe(
      "system",
    );
  });

  it("opens the first result when Enter is pressed", async () => {
    await render("/dashboard/settings/account");

    setQuery("incognito");
    press("Enter");

    // The row lives on Privacy and data, so landing there is the proof that the
    // first hit was opened rather than the query simply being dropped.
    expect(railCurrent()).toBe("Privacy and data");
    expect(searchInput()?.value).toBe("");
  });

  // Korean, Chinese and Japanese input goes through an IME, and there Enter
  // belongs to the composition: it confirms a candidate, it does not submit.
  // Opening the first hit on that keystroke would navigate away mid-word.
  it("leaves Enter to the input method while a composition is running", async () => {
    await render("/dashboard/settings/account");

    setQuery("incognito");
    press("Enter", { isComposing: true });

    expect(railCurrent()).toBe("Account");
    expect(searchInput()?.value).toBe("incognito");
  });

  // Engines report the composition boundary as key code 229, and the key it
  // carries can still read as Enter, which is the case the composition flag
  // alone does not cover.
  it("ignores the key the browser sends at a composition boundary", async () => {
    await render("/dashboard/settings/account");

    setQuery("incognito");
    press("Enter", { keyCode: 229 });

    expect(railCurrent()).toBe("Account");
    expect(searchInput()?.value).toBe("incognito");
  });

  it("shows the page when one is chosen from the rail mid-search", async () => {
    await render("/dashboard/settings/appearance");
    setQuery("incognito");
    expect(container.textContent).toContain("Privacy and data");

    // The rail changes the route without touching the query, so the results
    // panel would otherwise keep standing in for the page that was chosen.
    const railLink = [...container.querySelectorAll("a")].find(
      (link) => link.textContent === "Shortcuts",
    );
    act(() => {
      requireElement(railLink, "the Shortcuts rail link").dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(searchInput()?.value).toBe("");
    expect(railCurrent()).toBe("Shortcuts");
    // The results panel labels each group with an overline; the page header
    // does not, so its absence is what says the page is back.
    expect(container.querySelector(".MuiTypography-overline")).toBeNull();
  });

  it("clears the query on Escape without leaving the page", async () => {
    await render("/dashboard/settings/appearance");

    setQuery("incognito");
    press("Escape");

    expect(searchInput()?.value).toBe("");
    expect(railCurrent()).toBe("Appearance");
  });
});
