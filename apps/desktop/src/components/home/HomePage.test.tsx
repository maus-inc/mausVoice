// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material/styles";
import { theme } from "../../theme";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { createPreviewScenario } from "../../preview/scenarios";
import { setAppState } from "../../store";
import { INITIAL_APP_STATE } from "../../state/app.state";
vi.mock("./HomeSideEffects", async () => {
  const React = await import("react");
  const { getActivityDateRange } =
    await import("../../utils/activity-grid.utils");
  return {
    HomeSideEffects: ({
      onActivityChange,
    }: {
      onActivityChange: (next: unknown) => void;
    }) => {
      const range = getActivityDateRange();
      React.useEffect(() => {
        onActivityChange({
          status: "ready",
          records: [{ localDate: range.endDate, wordCount: 5 }],
          ...range,
          hasLoaded: true,
        });
      }, [onActivityChange, range.startDate, range.endDate]);
      return null;
    },
  };
});

vi.mock("./GettingStartedList", () => ({
  GettingStartedList: () => <div data-testid="getting-started-list" />,
}));

vi.mock("../common/DictationInstruction", () => ({
  DictationInstruction: () => <div data-testid="dictation-instruction" />,
}));

vi.mock("../transcriptions/TranscriptRow", () => ({
  TranscriptionRow: ({ id }: { id: string }) => (
    <div data-testid="transcription-row">{id}</div>
  ),
}));

import HomePage from "./HomePage";

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="current-route">{location.pathname}</output>;
};

beforeEach(() => {
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

const renderHome = (scenario: "populated" | "empty") => {
  const state = createPreviewScenario(scenario).state;
  setAppState(state, true);
  act(() => {
    root.render(
      createElement(
        IntlProvider,
        { locale: "en" },
        createElement(
          ThemeProvider,
          { theme },
          createElement(
            MemoryRouter,
            { initialEntries: ["/dashboard/home"] },
            createElement(HomePage),
            createElement(LocationProbe),
          ),
        ),
      ),
    );
  });
};

describe("HomePage analytics composition", () => {
  it("keeps the hotkey prompt, screenshot-led metric groups, heatmap, checklist, and recent rows", () => {
    renderHome("populated");

    const analytics = container.querySelector(
      'section[aria-label="Home analytics"]',
    );
    expect(analytics).not.toBeNull();
    expect(
      container.querySelector('[data-testid="dictation-instruction"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="getting-started-list"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="grid"]')).not.toBeNull();

    const metric = (label: string) =>
      [...(analytics?.querySelectorAll(".MuiCard-root") ?? [])].find((card) =>
        card.textContent?.includes(label),
      );
    expect(metric("Day streak")?.textContent).toContain("1");
    expect(metric("Words this month")?.textContent).toContain("127");
    expect(metric("Lifetime words")?.textContent).toContain("14,323");
    expect(metric("Speaking speed")?.textContent).toContain("73 WPM");
    expect(metric("Speaking speed")?.textContent).toContain(
      "3 recent dictations",
    );

    expect(
      [...container.querySelectorAll('[data-testid="transcription-row"]')].map(
        (row) => row.textContent,
      ),
    ).toEqual(["transcription-brief", "transcription-status"]);
  });

  it("shows a real no-sample WPM state instead of fabricated zero WPM", () => {
    renderHome("empty");

    const speedCard = [...container.querySelectorAll(".MuiCard-root")].find(
      (card) => card.textContent?.includes("Speaking speed"),
    );
    expect(speedCard?.textContent).toContain(
      "No recent dictations have usable audio duration yet.",
    );
    expect(speedCard?.textContent).not.toContain("0 WPM");
    expect(container.textContent).toContain("No transcriptions yet.");
  });

  it("keeps the existing View all route", async () => {
    renderHome("populated");

    const viewAll = [
      ...container.querySelectorAll<HTMLElement>('[role="button"]'),
    ].find((button) => button.textContent?.includes("View all"));
    if (!viewAll)
      throw new Error("Expected the recent-transcription View all action");

    await act(async () => viewAll.click());
    expect(
      container.querySelector('[data-testid="current-route"]')?.textContent,
    ).toBe("/dashboard/transcriptions");
  });
});
