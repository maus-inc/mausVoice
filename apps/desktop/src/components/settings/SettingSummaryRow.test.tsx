// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeProvider } from "@mui/material";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { theme } from "../../theme";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { requireElement } from "../../../test/helpers/dom";
import { SettingSummaryRow } from "./SettingSummaryRow";

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
 * The summary row is the overview's whole contract: it reports a setting that
 * lives elsewhere and takes you to that row. What it must never do is claim
 * that row's identity, which is what the anchor assertions here pin down.
 */
describe("SettingSummaryRow", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (row: React.ReactElement) =>
    act(() => {
      root.render(
        createElement(
          ThemeProvider,
          { theme },
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
                  row,
                  createElement(LocationProbe),
                ),
              }),
            ),
          ),
        ),
      );
    });

  const location = () =>
    requireElement(container.querySelector("#location"), "the location probe")
      .textContent;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reports a setting without claiming its anchor", () => {
    render(
      createElement(SettingSummaryRow, {
        linksTo: "ai_transcription",
        title: "AI transcription",
        value: "On this computer",
      }),
    );

    const row = requireElement(
      container.querySelector("button"),
      "the summary row",
    );
    expect(row.textContent).toContain("AI transcription");
    expect(row.textContent).toContain("On this computer");
    // The anchor belongs to the row on the page that owns the setting; a
    // second element carrying it would give deep links two targets.
    expect(container.querySelector('[id^="setting-"]')).toBeNull();
  });

  it("opens the setting's own row", () => {
    render(
      createElement(SettingSummaryRow, {
        linksTo: "ai_post_processing",
        title: "AI post processing",
      }),
    );

    act(() => {
      requireElement(
        container.querySelector("button"),
        "the summary row",
      ).click();
    });

    expect(location()).toBe(
      "/dashboard/settings/ai-models#setting-ai_post_processing",
    );
  });

  it("renders nothing when the setting it reports is no longer registered", () => {
    render(
      createElement(SettingSummaryRow, {
        linksTo: "a_setting_this_build_does_not_have",
        title: "Gone",
      }),
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).not.toContain("Gone");
  });

  it("opens a page for a row that is not a setting", () => {
    render(
      createElement(SettingSummaryRow, {
        path: "/dashboard/settings/shortcuts",
        title: "All shortcuts",
      }),
    );

    act(() => {
      requireElement(container.querySelector("button"), "the page row").click();
    });

    expect(location()).toBe("/dashboard/settings/shortcuts");
  });
});
