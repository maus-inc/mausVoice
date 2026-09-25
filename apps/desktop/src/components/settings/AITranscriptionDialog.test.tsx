// @vitest-environment jsdom
import { ThemeProvider, createTheme } from "@mui/material";
import type { ApiKey } from "@maus-inc/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

// The provider panel pulls in repos, Tauri and the download lifecycle. It is
// the child this disclosure sits under, not what is under test here.
vi.mock("./AITranscriptionConfiguration", () => ({
  AITranscriptionConfiguration: () =>
    createElement("div", null, "provider-panel"),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

import { IntlProvider } from "react-intl";
import { AITranscriptionDialog } from "./AITranscriptionDialog";
import en from "../../i18n/locales/en.json";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FOOTER = "Audio is sent to {provider} while you dictate";

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const openDialogWith = (provider?: ApiKey["provider"]) => {
  produceAppState((draft) => {
    draft.settings.aiTranscriptionDialogOpen = true;
    if (provider) {
      draft.apiKeyById = {
        "key-1": {
          id: "key-1",
          name: "key-1",
          provider,
          createdAt: "2026-01-01T00:00:00.000Z",
          keyFull: "sk-test",
        },
      };
      draft.settings.aiTranscription.mode = "api";
      draft.settings.aiTranscription.selectedApiKeyId = "key-1";
    } else {
      draft.settings.aiTranscription.mode = "local";
    }
  });
};

describe("AITranscriptionDialog audio transmission disclosure", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderDialog = async () => {
    await act(async () => {
      root.render(
        createElement(
          IntlProvider,
          { locale: "en", messages: en },
          createElement(
            ThemeProvider,
            { theme: createTheme() },
            createElement(AITranscriptionDialog),
          ),
        ),
      );
    });
  };

  beforeEach(() => {
    resetState();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetState();
  });

  it("names the selected provider by its bare display name", async () => {
    openDialogWith("assemblyai");
    await renderDialog();
    // The bare name, never the "API • AssemblyAI" session label.
    // The dialog renders through a portal, so the text lands on the document.
    const text = document.body.textContent ?? "";
    expect(text).toContain("Audio is sent to AssemblyAI while");
    expect(text).not.toContain("API • AssemblyAI");
  });

  it("says nothing about transmission in local mode", async () => {
    openDialogWith();
    await renderDialog();
    const text = document.body.textContent ?? "";
    expect(text).toContain("provider-panel");
    expect(text).not.toContain(FOOTER);
    expect(text).not.toContain("while you dictate");
  });
});
