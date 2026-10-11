// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The card's key names come from the platform's defaults, so this pins the
// platform rather than letting jsdom pick one.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { ThemeProvider } from "@mui/material";
import { theme } from "../../../theme";
import { INITIAL_APP_STATE } from "../../../state/app.state";
import { setAppState } from "../../../store";
import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../../test/helpers/dom";
import { seedManualStyles } from "../../../../test/helpers/tone-test.utils";
import en from "../../../i18n/locales/en.json";
import HomeSettingsPage from "./HomeSettingsPage";

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
 * The overview's job is to answer from the store and then hand off, so these
 * tests read what a person would read — the rows — and check that each one
 * points at the page that owns the setting it reports.
 */
describe("HomeSettingsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = () =>
    act(() => {
      root.render(
        createElement(
          ThemeProvider,
          { theme },
          createElement(
            IntlProvider,
            { locale: "en", messages: en },
            createElement(
              MemoryRouter,
              { initialEntries: ["/dashboard/settings/home"] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: "*",
                  element: createElement(
                    "div",
                    null,
                    createElement(HomeSettingsPage),
                    createElement(LocationProbe),
                  ),
                }),
              ),
            ),
          ),
        ),
      );
    });

  const row = (title: string) =>
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(title),
    );

  const click = (element: Element) =>
    act(() => {
      (element as HTMLElement).click();
    });

  const location = () =>
    requireElement(container.querySelector("#location"), "the location probe")
      .textContent;

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

  it("lands on the two cards the overview is made of", () => {
    render();

    expect(container.textContent).toContain("Shortcuts");
    expect(container.textContent).toContain("Your models");
    expect(container.textContent).toContain("All shortcuts");
    expect(container.textContent).toContain("Manage models");
  });

  it("reports the bound combo, and says so when nothing is bound", () => {
    render();

    // Dictation runs on a platform default before any key is customised, so
    // the row reports one; Open chat ships unbound, and an empty control would
    // read as a broken row rather than an unset one.
    expect(row("Hold to dictate")?.textContent).toContain("Ctrl");
    expect(row("Open chat")?.textContent).toContain("Not set");
  });

  it("adds the style keys only while styling is manual", () => {
    render();
    expect(row("Next writing style")).toBeUndefined();

    act(() => {
      seedManualStyles("default");
    });
    expect(row("Previous writing style")).not.toBeUndefined();
    expect(row("Next writing style")).not.toBeUndefined();
  });

  it("names the local model and where it runs", () => {
    render();

    expect(row("AI transcription")?.textContent).toContain(
      "Whisper Tiny (77 MB)",
    );
    expect(row("AI transcription")?.textContent).toContain("On this computer");
  });

  it("calls a local model missing only once its statuses have loaded", () => {
    render();
    expect(container.textContent).not.toContain("Not downloaded yet");

    act(() => {
      setAppState((state) => ({
        ...state,
        settings: {
          ...state.settings,
          aiTranscription: {
            ...state.settings.aiTranscription,
            localModelManagement: {
              ...state.settings.aiTranscription.localModelManagement,
              modelStatusesLoaded: true,
            },
          },
        },
      }));
    });

    expect(row("AI transcription")?.textContent).toContain(
      "Not downloaded yet",
    );
  });

  it("names the provider once one is selected, and says off when none is", () => {
    // Post-processing and the assistant default to off; off is a state the
    // card states, because an empty row would be indistinguishable from a
    // setting that failed to load.
    render();
    expect(row("AI post processing")?.textContent).toContain("Off");
    expect(row("Assistant mode")?.textContent).toContain("Off");

    act(() => {
      setAppState((state) => ({
        ...state,
        apiKeyById: {
          "key-1": {
            id: "key-1",
            name: "Groq",
            provider: "groq",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
        settings: {
          ...state.settings,
          aiPostProcessing: { mode: "api", selectedApiKeyId: "key-1" },
          agentMode: {
            ...state.settings.agentMode,
            mode: "api",
            selectedApiKeyId: "key-1",
          },
        },
      }));
    });

    expect(row("AI post processing")?.textContent).toContain("Groq");
    expect(row("AI post processing")?.textContent).toContain("Cloud");
    expect(row("Assistant mode")?.textContent).toContain("Groq");
  });

  it("links each row to the setting it reports", () => {
    render();

    click(requireElement(row("AI transcription"), "the transcription row"));

    expect(location()).toBe(
      "/dashboard/settings/ai-models#setting-ai_transcription",
    );
  });

  it("links the footer rows to the pages that own the detail", () => {
    render();

    click(requireElement(row("All shortcuts"), "the shortcuts link"));
    expect(location()).toBe("/dashboard/settings/shortcuts");

    click(requireElement(row("Manage models"), "the models link"));
    expect(location()).toBe("/dashboard/settings/ai-models");
  });

  it("claims no setting anchors of its own", () => {
    render();

    // Anchors belong to the page that owns a setting, and the registry test
    // asserts each is used exactly once. The overview only points at them, so
    // an id here would be a duplicate deep-link target.
    expect(container.querySelector('[id^="setting-"]')).toBeNull();
  });
});
