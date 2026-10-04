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

const STREAMING_CLAIM = "as you speak";
// A batch session pretranscribes at natural pauses, so a completed chunk
// is already on the provider while the user keeps talking. The old copy
// ("only after you stop, so cancelling sends nothing") was false.
const BATCH_CLAIM = "as you pause";

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

  it("discloses streaming for a provider that streams while you talk", async () => {
    selectCloudProvider("assemblyai");
    await renderForm();
    expect(container.textContent).toContain(STREAMING_CLAIM);
    expect(container.textContent).not.toContain(BATCH_CLAIM);
  });

  it("discloses the upload point for a provider that transcribes in batch", async () => {
    // Groq dispatches to BatchTranscriptionSession, so nothing is sent while
    // the user is still talking.
    selectCloudProvider("groq");
    await renderForm();
    expect(container.textContent).toContain(BATCH_CLAIM);
    expect(container.textContent).not.toContain(STREAMING_CLAIM);
  });

  it("says nothing about transmission in local mode", async () => {
    selectLocalProvider();
    await renderForm();
    expect(container.textContent).toContain("provider-panel");
    expect(container.textContent).not.toContain(STREAMING_CLAIM);
    expect(container.textContent).not.toContain(BATCH_CLAIM);
  });

  it("claims nothing while no provider has been chosen", async () => {
    // The disclosure names the provider, so before a key row is selected there
    // is nothing to name. Claiming a transmission with no subject would also
    // have to guess between live streaming and an upload after the stop.
    produceAppState((draft) => {
      draft.settings.aiTranscription.mode = "api";
    });
    await renderForm();
    expect(container.textContent).not.toContain(STREAMING_CLAIM);
    expect(container.textContent).not.toContain(BATCH_CLAIM);
  });

  it("discloses as soon as the key row is picked, before its value is typed", async () => {
    // The key value is not what makes a transmission true, the provider is, so
    // an empty key row must not hide the copy.
    produceAppState((draft) => {
      draft.apiKeyById = {
        "key-1": {
          id: "key-1",
          name: "key-1",
          provider: "assemblyai",
          createdAt: "2026-01-01T00:00:00.000Z",
          keyFull: null,
        },
      };
      draft.settings.aiTranscription.mode = "api";
      draft.settings.aiTranscription.selectedApiKeyId = "key-1";
    });
    await renderForm();
    expect(container.textContent).toContain(STREAMING_CLAIM);
  });
});
