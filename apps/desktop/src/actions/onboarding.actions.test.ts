import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

vi.mock("../utils/analytics.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/analytics.utils")>();
  return {
    ...actual,
    trackOnboardingStep: vi.fn(),
    trackOnboardingOutcome: vi.fn(),
    trackButtonClick: vi.fn(),
  };
});

vi.mock("../utils/env.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/env.utils")>();
  return { ...actual, isMacOS: () => false };
});

import {
  CURRENT_ONBOARDING_FLOW_VERSION,
  dismissTip,
  ensureOnboardingFlow,
  goBackOnboardingPage,
  goToOnboardingPage,
  markPrerequisite,
  resetTip,
  resumeOnboardingPage,
} from "./onboarding.actions";
import {
  trackOnboardingOutcome,
  trackOnboardingStep,
} from "../utils/analytics.utils";

const seed = () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
};

describe("onboarding navigation outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("records completion with elapsed time on forward nav", async () => {
    const { markOnboardingStepEntered } = await import("./onboarding.actions");
    markOnboardingStepEntered("signIn");
    goToOnboardingPage("personalCredentials");

    expect(getAppState().onboarding.currentPage).toBe("personalCredentials");
    expect(trackOnboardingOutcome).toHaveBeenCalledWith(
      "signIn",
      "complete",
      expect.any(Number),
    );
  });

  it("records skips distinctly from completions", () => {
    goToOnboardingPage("micCheck", "skip");
    expect(trackOnboardingOutcome).toHaveBeenCalledWith(
      "signIn",
      "skip",
      undefined,
    );
  });

  it("records back nav and restores the previous page", () => {
    goToOnboardingPage("personalCredentials");
    goToOnboardingPage("chooseTranscription");
    goBackOnboardingPage();

    expect(getAppState().onboarding.currentPage).toBe("personalCredentials");
    expect(trackOnboardingOutcome).toHaveBeenCalledWith(
      "chooseTranscription",
      "back",
      undefined,
    );
  });

  it("persists the resume page on every nav", () => {
    goToOnboardingPage("micCheck");
    expect(getAppState().local.onboardingResumePage).toBe("micCheck");
  });

  it("still tracks step entry for the shell", () => {
    expect(trackOnboardingStep).toBeDefined();
  });
});

describe("onboarding flow migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("remaps removed pages to their nearest kept page", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.onboarding.currentPage = "referralSource";
    next.onboarding.history = ["userDetails", "chooseLlm"];
    next.local.onboardingResumePage = "unlockedPro";
    next.local.onboardingFlowVersion = 0;
    setAppState(next, true);

    ensureOnboardingFlow();

    const migrated = getAppState();
    expect(migrated.onboarding.currentPage).toBe("keybindings");
    expect(migrated.onboarding.history).toEqual([
      "chooseTranscription",
      "keybindings",
    ]);
    expect(migrated.local.onboardingResumePage).toBe("tutorial");
    expect(migrated.local.onboardingFlowVersion).toBe(
      CURRENT_ONBOARDING_FLOW_VERSION,
    );
  });

  it("leaves current-version state untouched", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.onboarding.currentPage = "micCheck";
    next.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
    setAppState(next, true);

    ensureOnboardingFlow();

    expect(getAppState().onboarding.currentPage).toBe("micCheck");
  });

  it("resumes persisted progress only with an empty nav stack", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.local.onboardingResumePage = "micCheck";
    next.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
    setAppState(next, true);

    resumeOnboardingPage();

    expect(getAppState().onboarding.currentPage).toBe("micCheck");
    expect(getAppState().local.onboardingResumePage).toBe("micCheck");
  });
});

describe("prerequisites and tips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("dedupes prerequisites", () => {
    markPrerequisite("microphone");
    markPrerequisite("microphone");
    expect(getAppState().local.completedPrerequisites).toEqual(["microphone"]);
  });

  it("dismisses and restores tips", () => {
    dismissTip("writing-styles");
    expect(getAppState().local.dismissedTipIds).toEqual(["writing-styles"]);
    dismissTip("writing-styles");
    expect(getAppState().local.dismissedTipIds).toEqual(["writing-styles"]);
    resetTip("writing-styles");
    expect(getAppState().local.dismissedTipIds).toEqual([]);
  });
});
