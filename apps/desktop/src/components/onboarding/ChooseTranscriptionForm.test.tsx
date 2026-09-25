// @vitest-environment jsdom
import { ThemeProvider, createTheme } from "@mui/material";
import type { ApiKey } from "@maus-inc/types";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  goToOnboardingPage: vi.fn(),
  trackButtonClick: vi.fn(),
}));

vi.mock("../../actions/onboarding.actions", () => ({
  goToOnboardingPage: mocks.goToOnboardingPage,
}));

vi.mock("../../utils/analytics.utils", () => ({
  trackButtonClick: mocks.trackButtonClick,
}));

// The provider panel pulls in repos, Tauri and the download lifecycle. It is
// the child this disclosure sits under, not what is under test here.
vi.mock("../settings/AITranscriptionConfiguration", () => ({
  AITranscriptionConfiguration: () =>
    createElement("div", null, "provider-panel"),
}));

vi.mock("./OnboardingCommon", async () => {
  const { createElement: create } = await import("react");
  return {
    BackButton: () => null,
    DualPaneLayout: ({ left }: { left?: ReactNode }) =>
      create("div", null, left),
    OnboardingContinueButton: () => null,
    OnboardingFormHeader: () => null,
    OnboardingFormLayout: ({ children }: { children?: ReactNode }) =>
      create("div", null, children),
  };
});

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ChooseTranscriptionForm } from "./ChooseTranscriptionForm";

ensureUiHarness();

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DISCLOSURE = "Audio is sent to your provider as you speak";

const resetState = () => setAppState(structuredClone(INITIAL_APP_STATE), true);

const selectCloudProvider = (provider: ApiKey["provider"] = "assemblyai") => {
  produceAppState((draft) => {
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
  });
};

const selectLocalProvider = () => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.mode = "local";
  });
};

describe("ChooseTranscriptionForm audio transmission disclosure", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderForm = async () => {
    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { theme: createTheme() },
          createElement(ChooseTranscriptionForm),
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

  it("discloses streaming to a cloud provider", async () => {
    selectCloudProvider();
    await renderForm();
    expect(container.textContent).toContain(DISCLOSURE);
  });

  it("says nothing about transmission in local mode", async () => {
    selectLocalProvider();
    await renderForm();
    expect(container.textContent).toContain("provider-panel");
    expect(container.textContent).not.toContain(DISCLOSURE);
  });

  it("does not depend on a key being saved yet", async () => {
    produceAppState((draft) => {
      draft.settings.aiTranscription.mode = "api";
    });
    await renderForm();
    expect(container.textContent).toContain(DISCLOSURE);
  });
});
