// @vitest-environment jsdom
import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dismissMock, retryMock } = vi.hoisted(() => ({
  dismissMock: vi.fn(),
  retryMock: vi.fn(),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../actions/voquill-migration.actions", () => ({
  dismissVoquillMigration: dismissMock,
  runVoquillMigrationRetry: retryMock,
}));

import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import en from "../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { setAppState } from "../../store";
import { theme } from "../../theme";
import { VoquillMigrationBanner } from "./VoquillMigrationBanner";

ensureUiHarness();

const LocationProbe = () => {
  const location = useLocation();
  return createElement(
    "output",
    { id: "location" },
    `${location.pathname}${location.hash}`,
  );
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
  dismissedAt: null,
  attemptCount: 1,
  databasePhase: "migrated",
  modelsPhase: "migrated",
  audioPhase: "not_found",
  storagePhase: "not_found",
  counts: {
    hasProfile: true,
    hasPreferences: true,
    transcriptions: 15,
    dictionaryTerms: 6,
    tones: 2,
    hotkeys: 4,
    appTargets: 1,
    providerEntries: 2,
    providersNeedingAttention: 0,
    localModelsMigrated: 1,
    audioFilesMigrated: 0,
    storageFilesMigrated: 0,
  },
  removedModesReset: [],
  actionItems: [],
  issues: [],
  ...overrides,
});

describe("VoquillMigrationBanner", () => {
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
              { initialEntries: ["/dashboard/home"] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: "*",
                  element: createElement(
                    "div",
                    null,
                    createElement(VoquillMigrationBanner),
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
    dismissMock.mockReset().mockResolvedValue(null);
    retryMock.mockReset();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when migration is not needed or already dismissed", () => {
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: makeReport({ legacyDetected: false, status: "not_needed" }),
      },
    }));
    render();
    expect(
      container.querySelector('[data-testid="voquill-migration-banner"]'),
    ).toBeNull();

    act(() => {
      setAppState((s) => ({
        ...s,
        voquillMigration: {
          ...s.voquillMigration,
          status: "success",
          report: makeReport({ dismissedAt: "2026-11-24T01:00:00Z" }),
        },
      }));
    });
    render();
    expect(
      container.querySelector('[data-testid="voquill-migration-banner"]'),
    ).toBeNull();
  });

  it("shows action-needed state, links directly to AI Models and Privacy & Data, and surfaces dismiss failure", async () => {
    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: makeReport({
          counts: {
            ...makeReport().counts,
            providersNeedingAttention: 2,
          },
          actionItems: [
            {
              kind: "reenter_api_keys",
              targetSection: "ai-models",
              count: 2,
              providers: ["Groq", "Deepgram"],
            },
          ],
        }),
      },
    }));

    render();

    expect(container.textContent).toContain(
      "Imported from Voquill — action needed",
    );
    expect(container.textContent).toContain("15 transcriptions");
    expect(container.textContent).toContain(
      "2 saved API providers need attention before they can be used.",
    );
    expect(container.textContent).toContain(
      "Your original Voquill files were left untouched.",
    );

    const buttons = Array.from(container.querySelectorAll("button"));
    const reviewBtn = buttons.find((b) =>
      b.textContent?.includes("Review API keys"),
    );
    expect(reviewBtn).toBeDefined();
    act(() => reviewBtn!.click());
    expect(container.querySelector("#location")?.textContent).toBe(
      "/dashboard/settings/ai-models",
    );

    const detailsBtn = buttons.find((b) =>
      b.textContent?.includes("View details"),
    );
    expect(detailsBtn).toBeDefined();
    act(() => detailsBtn!.click());
    expect(container.querySelector("#location")?.textContent).toBe(
      "/dashboard/settings/privacy-data#setting-voquill_migration",
    );

    const dismissBtn = container.querySelector(
      'button[aria-label="Dismiss Voquill migration notice"]',
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();
    await act(async () => {
      dismissBtn!.click();
      await Promise.resolve();
    });
    expect(dismissMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Could not dismiss this notice right now. Try again.",
    );
  });

  it("shows Retry import only when canRetry is true and triggers retry", async () => {
    const failed = makeReport({
      status: "failed",
      canRetry: true,
      databasePhase: "failed",
      issues: [
        {
          category: "database",
          code: "database_copy_failed",
          detail: "raw path /secret/voquill.db should never render",
        },
      ],
    });
    retryMock.mockResolvedValue(makeReport({ status: "completed" }));

    setAppState((s) => ({
      ...s,
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: failed,
      },
    }));

    render();

    expect(container.textContent).toContain(
      "Could not import your Voquill data",
    );
    // Localized issue message renders; raw backend string is never displayed.
    expect(container.textContent).toContain(
      "The Voquill database could not be copied.",
    );
    expect(container.textContent).not.toContain("/secret/voquill.db");

    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Retry import"),
    );
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn!.click();
    });
    expect(retryMock).toHaveBeenCalledTimes(1);
  });
});
