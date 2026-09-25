// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../root/AppSideEffects", () => ({ AppSideEffects: () => null }));
vi.mock("../../utils/analytics.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/analytics.utils")>()),
  trackOnboardingStep: vi.fn(),
  trackOnboardingOutcome: vi.fn(),
  trackButtonClick: vi.fn(),
}));
vi.mock("../login/LoginForm", () => ({ LoginForm: () => null }));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import OnboardingPage from "./OnboardingPage";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.initialized = true;
  state.onboarding.currentPage = "signIn";
  state.onboarding.title = "Old title";
  state.onboarding.company = "Old company";
  state.onboarding.name = "Maria Garcia";
  state.onboarding.firstName = "Maria";
  state.onboarding.lastName = "Garcia";
  state.onboarding.lastNameEnabled = true;
  state.local.onboardingResumePage = null;
  state.local.onboardingNameDraft = "Maria Garcia";
  state.local.onboardingNameDraftUserId = "first-user-id";
  state.auth = {
    uid: "first-user-id",
    email: "first@example.com",
    displayName: "Maria Garcia",
    providers: ["password"],
  };
  state.userById["first-user-id"] = {
    id: "first-user-id",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    name: "Maria Garcia",
    onboarded: false,
    playInteractionChime: true,
    hasFinishedTutorial: false,
    wordsThisMonth: 0,
    wordsTotal: 0,
  };
  setAppState(state, true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("OnboardingPage auth handoff", () => {
  it("resets account-scoped onboarding state when the UID changes", async () => {
    await act(async () => {
      root.render(
        createElement(MemoryRouter, null, createElement(OnboardingPage)),
      );
    });

    const next = structuredClone(getAppState());
    next.auth = {
      uid: "second-user-id",
      email: "second@example.com",
      displayName: "Bob Jones",
      providers: ["password"],
    };
    next.userById["second-user-id"] = {
      id: "second-user-id",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "Bob Jones",
      onboarded: false,
      playInteractionChime: true,
      hasFinishedTutorial: false,
      wordsThisMonth: 0,
      wordsTotal: 0,
    };
    next.authSessionNonce += 1;
    act(() => setAppState(next, true));

    expect(getAppState().onboarding.name).toBe("Bob Jones");
    expect(getAppState().onboarding.title).toBe("");
    expect(getAppState().onboarding.company).toBe("");
    expect(getAppState().local.onboardingResumePage).toBe(
      "personalCredentials",
    );
    expect(getAppState().local.onboardingNameDraft).toBe("Bob Jones");
    expect(getAppState().local.onboardingNameDraftUserId).toBe(
      "second-user-id",
    );
  });
});
