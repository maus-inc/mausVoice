// @vitest-environment jsdom
import type { VoquillMigrationReport } from "@maus-inc/desktop-native-apis";
import type { ApiKey } from "@maus-inc/types";
import { ThemeProvider } from "@mui/material";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../../actions/user.actions", () => ({
  setFastStyleShortDictationsEnabled: vi.fn(async () => {}),
  setStylingMode: vi.fn(async () => {}),
}));

import { ensureUiHarness } from "../../../../test/helpers/jsdom-ui-harness";
import en from "../../../i18n/locales/en.json";
import { INITIAL_APP_STATE } from "../../../state/app.state";
import { setAppState } from "../../../store";
import { theme } from "../../../theme";
import AiModelsSettingsPage from "./AiModelsSettingsPage";

ensureUiHarness();

const makeAttentionKey = (id: string): ApiKey => ({
  id,
  name: "Migrated Groq",
  provider: "groq",
  keySuffix: "1234",
  keyFull: null,
  credentialStatus: "needs_reentry",
  credentialIssue: "legacy_encryption",
  createdAt: "2026-11-24T00:00:00Z",
});

const makeMigrationReport = (
  removedModesReset: string[],
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
  modelsPhase: "not_found",
  audioPhase: "not_found",
  storagePhase: "not_found",
  counts: {
    hasProfile: true,
    hasPreferences: true,
    transcriptions: 0,
    dictionaryTerms: 0,
    tones: 0,
    hotkeys: 0,
    appTargets: 0,
    providerEntries: 1,
    providersNeedingAttention: 1,
    localModelsMigrated: 0,
    audioFilesMigrated: 0,
    storageFilesMigrated: 0,
  },
  removedModesReset,
  actionItems: [],
  issues: [],
});

describe("AiModelsSettingsPage", () => {
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
              null,
              createElement(AiModelsSettingsPage),
            ),
          ),
        ),
      );
    });

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

  it("renders both the API key attention warning and cloud-mode reset notice together", () => {
    const key = makeAttentionKey("key-groq");
    setAppState((s) => ({
      ...s,
      apiKeyById: { [key.id]: key },
      settings: {
        ...s.settings,
        apiKeys: [key],
        apiKeysStatus: "success",
      },
      voquillMigration: {
        ...s.voquillMigration,
        status: "success",
        report: makeMigrationReport(["transcriptionMode:cloud->local"]),
      },
    }));

    render();

    expect(container.textContent).toContain(
      "1 saved API provider below needs attention before it can be used.",
    );
    expect(container.textContent).toContain(
      "Previous Voquill Cloud mode selections were reset to local or off during migration. Choose a local model or personal API provider below.",
    );
  });

  it("omits Not configured and missing-key attention chips until API keys have loaded", () => {
    for (const status of ["idle", "loading", "error"] as const) {
      act(() => {
        setAppState((s) => ({
          ...s,
          apiKeyById: {},
          settings: {
            ...s.settings,
            apiKeys: [],
            apiKeysStatus: status,
            aiTranscription: {
              ...s.settings.aiTranscription,
              mode: "api",
              selectedApiKeyId: "key-pending-load",
            },
          },
        }));
      });

      render();

      expect(container.textContent).not.toContain("Not configured");
      expect(container.textContent).not.toContain("Needs attention");
    }

    act(() => {
      setAppState((s) => ({
        ...s,
        apiKeyById: {},
        settings: {
          ...s.settings,
          apiKeys: [],
          apiKeysStatus: "success",
          aiTranscription: {
            ...s.settings.aiTranscription,
            mode: "api",
            selectedApiKeyId: "key-actually-missing",
          },
        },
      }));
    });

    render();

    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("Needs attention");
  });
});
