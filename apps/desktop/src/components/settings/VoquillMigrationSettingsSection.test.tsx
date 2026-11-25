// @vitest-environment jsdom
import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { retryMock } = vi.hoisted(() => ({
  retryMock: vi.fn(),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../actions/voquill-migration.actions", () => ({
  runVoquillMigrationRetry: retryMock,
}));

import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { theme } from "../../theme";
import { VoquillMigrationSettingsSection } from "./VoquillMigrationSettingsSection";

ensureUiHarness();

const LocationProbe = () => {
  const location = useLocation();
  return createElement("output", { id: "location" }, location.pathname);
};

const makeReport = (
  overrides: Partial<VoquillMigrationReport> = {},
): VoquillMigrationReport => ({
  schemaVersion: 1,
  status: "completed",
  legacyDetected: true,
  legacySourcePreserved: true,
  canRetry: false,
  detectedAt: "2026-11-24T00:00:00Z",
  completedAt: "2026-11-24T00:00:01Z",
  dismissedAt: "2026-11-24T02:00:00Z",
  attemptCount: 1,
  databasePhase: "migrated",
  modelsPhase: "partial",
  audioPhase: "migrated",
  storagePhase: "not_found",
  counts: {
    hasProfile: true,
    hasPreferences: true,
    transcriptions: 42,
    dictionaryTerms: 11,
    tones: 3,
    hotkeys: 2,
    appTargets: 0,
    providerEntries: 2,
    providersNeedingAttention: 1,
    localModelsMigrated: 1,
    audioFilesMigrated: 5,
    storageFilesMigrated: 0,
  },
  removedModesReset: ["cloud"],
  actionItems: [
    {
      kind: "reenter_api_keys",
      targetSection: "ai-models",
      count: 1,
      providers: ["Groq"],
    },
    {
      kind: "review_cloud_mode_reset",
      targetSection: "ai-models",
      count: 1,
      providers: [],
    },
  ],
  issues: [],
  ...overrides,
});

describe("VoquillMigrationSettingsSection", () => {
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
              { initialEntries: ["/dashboard/settings/privacy-data"] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: "*",
                  element: createElement(
                    "div",
                    null,
                    createElement(VoquillMigrationSettingsSection),
                    createElement(LocationProbe),
                  ),
                }),
              ),
            ),
          ),
        ),
      );
    });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    retryMock.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("stays visible after banner dismissal and links to AI & Models", () => {
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: makeReport({ status: "partial", canRetry: true }),
      },
    }));

    render();

    expect(
      container.querySelector("#setting-voquill_migration"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Voquill migration");
    expect(container.textContent).toContain("Partial");
    expect(container.textContent).toContain("42 transcriptions");
    expect(container.textContent).toContain("Database: Imported");
    expect(container.textContent).toContain("Models: Partially imported");
    expect(container.textContent).toContain("Audio: Imported");
    expect(container.textContent).toContain(
      "Previous Voquill Cloud settings were reset to local or off",
    );

    const reviewBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Review API keys"),
    );
    expect(reviewBtn).toBeDefined();
    act(() => reviewBtn!.click());
    expect(container.querySelector("#location")?.textContent).toBe(
      "/dashboard/settings/ai-models",
    );
  });
});
