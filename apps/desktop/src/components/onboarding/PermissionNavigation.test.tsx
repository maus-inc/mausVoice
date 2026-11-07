// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../../utils/env.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/env.utils")>()),
  isMacOS: () => true,
}));
vi.mock("../../utils/analytics.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/analytics.utils")>()),
  trackOnboardingOutcome: vi.fn(),
  trackButtonClick: vi.fn(),
}));
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import {
  goBackOnboardingPage,
  goToOnboardingPage,
  resumeOnboardingPage,
} from "../../actions/onboarding.actions";
import { trackOnboardingOutcome } from "../../utils/analytics.utils";
import { A11yPermsForm } from "./A11yPermsForm";
import { MicPermsForm } from "./MicPermsForm";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;
const render = async (component: typeof MicPermsForm) => {
  await act(async () =>
    root.render(createElement(MemoryRouter, null, createElement(component))),
  );
};
beforeEach(() => {
  vi.clearAllMocks();
  setMatchMedia(false);
  const state = structuredClone(INITIAL_APP_STATE);
  state.permissions.microphone = {
    kind: "microphone",
    state: "authorized",
    promptShown: true,
  };
  state.permissions.accessibility = {
    kind: "accessibility",
    state: "authorized",
    promptShown: true,
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

describe("permission onboarding navigation", () => {
  it.each([
    ["micPerms", "a11yPerms", MicPermsForm],
    ["a11yPerms", "keybindings", A11yPermsForm],
  ] as const)(
    "can revisit authorized %s using Back",
    async (page, next, component) => {
      goToOnboardingPage("chooseTranscription");
      goToOnboardingPage(page);
      goToOnboardingPage(next);
      goBackOnboardingPage();
      await render(component);
      expect(getAppState().onboarding.currentPage).toBe(page);
      expect(getAppState().local.onboardingResumePage).toBe(page);
    },
  );

  it("resumes granted permission steps without inventing history or completion", async () => {
    const state = structuredClone(getAppState());
    state.local.onboardingResumePage = "micPerms";
    setAppState(state, true);
    resumeOnboardingPage();
    await render(MicPermsForm);
    expect(getAppState().onboarding.currentPage).toBe("a11yPerms");
    await render(A11yPermsForm);
    expect(getAppState().onboarding.currentPage).toBe("keybindings");
    expect(getAppState().onboarding.history).toEqual([]);
    expect(getAppState().local.completedPrerequisites).toEqual(
      expect.arrayContaining(["microphone", "accessibility"]),
    );
    expect(trackOnboardingOutcome).not.toHaveBeenCalled();
  });
});
