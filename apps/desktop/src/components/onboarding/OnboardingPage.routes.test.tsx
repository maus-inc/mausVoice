// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import type { OnboardingPageKey } from "../../state/onboarding.state";
import { setAppState } from "../../store";

vi.mock("../../actions/onboarding.actions", () => ({
  ensureOnboardingFlow: vi.fn(),
  markOnboardingStepEntered: vi.fn(),
  resumeOnboardingPage: vi.fn(),
}));
vi.mock("../../utils/analytics.utils", () => ({
  trackOnboardingStep: vi.fn(),
}));
vi.mock("./SignInForm", () => ({ SignInForm: () => "signIn" }));
vi.mock("./PersonalCredentialsForm", () => ({
  PersonalCredentialsForm: () => "personalCredentials",
}));
vi.mock("./ChooseTranscriptionForm", () => ({
  ChooseTranscriptionForm: () => "chooseTranscription",
}));
vi.mock("./ChooseLlmForm", () => ({ ChooseLlmForm: () => "chooseLlm" }));
vi.mock("./UserDetailsForm", () => ({ UserDetailsForm: () => "userDetails" }));
vi.mock("./ReferralSourceForm", () => ({
  ReferralSourceForm: () => "referralSource",
}));
vi.mock("./MicPermsForm", () => ({ MicPermsForm: () => "micPerms" }));
vi.mock("./A11yPermsForm", () => ({ A11yPermsForm: () => "a11yPerms" }));
vi.mock("./KeybindingsForm", () => ({ KeybindingsForm: () => "keybindings" }));
vi.mock("./MicCheckForm", () => ({ MicCheckForm: () => "micCheck" }));
vi.mock("./UnlockedProForm", () => ({ UnlockedProForm: () => "unlockedPro" }));
vi.mock("./TutorialForm", () => ({ TutorialForm: () => "tutorial" }));

import OnboardingPage from "./OnboardingPage";

ensureUiHarness();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("renders exactly the selected onboarding page and rejects unknown keys", async () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.initialized = true;
  setAppState(state, true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(OnboardingPage)));
    const pages: OnboardingPageKey[] = [
      "signIn",
      "personalCredentials",
      "chooseTranscription",
      "chooseLlm",
      "userDetails",
      "referralSource",
      "micPerms",
      "a11yPerms",
      "keybindings",
      "micCheck",
      "unlockedPro",
      "tutorial",
    ];
    for (const page of pages) {
      act(() =>
        setAppState((previous) => ({
          onboarding: { ...previous.onboarding, currentPage: page },
        })),
      );
      expect(container.textContent).toBe(page);
    }
    act(() =>
      setAppState((previous) => ({
        onboarding: {
          ...previous.onboarding,
          currentPage: "constructor" as OnboardingPageKey,
        },
      })),
    );
    expect(container.textContent).toBe("");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
