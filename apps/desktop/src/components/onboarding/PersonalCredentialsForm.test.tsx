// @vitest-environment jsdom
import { ThemeProvider, createTheme } from "@mui/material";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

const mocks = vi.hoisted(() => ({
  goToOnboardingPage: vi.fn(),
  openUrl: vi.fn(async () => undefined),
  savePersonalDeepgramApiKey: vi.fn(async () => undefined),
  savePersonalGroqApiKey: vi.fn(async () => undefined),
  trackButtonClick: vi.fn(),
}));

vi.mock("../../actions/onboarding.actions", () => ({
  goToOnboardingPage: mocks.goToOnboardingPage,
}));

vi.mock("../../actions/personal-use.actions", () => ({
  savePersonalDeepgramApiKey: mocks.savePersonalDeepgramApiKey,
  savePersonalGroqApiKey: mocks.savePersonalGroqApiKey,
}));

vi.mock("../../utils/analytics.utils", () => ({
  trackButtonClick: mocks.trackButtonClick,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
  };
});

vi.mock("./OnboardingCommon", async () => {
  const { createElement: create } = await import("react");

  return {
    BackButton: () => null,
    DualPaneLayout: ({
      left,
      right,
    }: {
      left?: ReactNode;
      right?: ReactNode;
    }) => create("div", { "data-slot": "dual-pane" }, left, right),
    OnboardingFormLayout: ({
      back,
      children,
      actions,
    }: {
      back?: ReactNode;
      children?: ReactNode;
      actions?: ReactNode;
    }) => create("div", null, back, children, actions),
  };
});

import { PersonalCredentialsForm } from "./PersonalCredentialsForm";

ensureUiHarness();

const testTheme = createTheme({
  components: { MuiDialog: { defaultProps: { transitionDuration: 0 } } },
});

const findButton = (
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
};

describe("PersonalCredentialsForm API key skip confirmation", () => {
  let container: HTMLDivElement;
  let root: Root;

  const renderForm = async () => {
    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { theme: testTheme },
          createElement(PersonalCredentialsForm),
        ),
      );
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("describes where to get each provider key", async () => {
    await renderForm();

    expect(findButton("Grab your Deepgram API key")).toBeDefined();
    expect(findButton("Grab your Groq API key")).toBeDefined();
  });

  it("names the dialog title and performance warning, then keeps the user on the form", async () => {
    await renderForm();
    await click(findButton("Skip for now"));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const titleId = dialog?.getAttribute("aria-labelledby");
    const contentId = dialog?.getAttribute("aria-describedby");
    expect(document.getElementById(titleId ?? "")?.textContent).toBe(
      "Skip API key setup?",
    );
    expect(document.getElementById(contentId ?? "")?.textContent).toBe(
      "Local models use more system resources and run slower than API-based models. You can add your keys later in Settings.",
    );
    expect(document.activeElement?.textContent?.trim()).toBe("Go back");
    expect(mocks.goToOnboardingPage).not.toHaveBeenCalled();
    expect(mocks.trackButtonClick).toHaveBeenCalledWith(
      "onboarding_open_skip_api_key_confirmation",
    );

    await click(findButton("Go back", dialog!));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    expect(mocks.goToOnboardingPage).not.toHaveBeenCalled();
    expect(mocks.trackButtonClick).not.toHaveBeenCalledWith(
      "onboarding_personal_credentials_skip",
    );
    expect(mocks.trackButtonClick).toHaveBeenCalledWith(
      "onboarding_cancel_skip_api_key_confirmation",
    );
  });

  it("advances to transcription setup with a skip outcome only after confirmation", async () => {
    await renderForm();
    await click(findButton("Skip for now"));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(mocks.goToOnboardingPage).not.toHaveBeenCalled();
    await click(findButton("Skip for now", dialog!));

    expect(mocks.goToOnboardingPage).toHaveBeenCalledTimes(1);
    expect(mocks.goToOnboardingPage).toHaveBeenCalledWith(
      "chooseTranscription",
      "skip",
    );
    expect(mocks.trackButtonClick).toHaveBeenCalledWith(
      "onboarding_personal_credentials_skip",
    );
  });
});
