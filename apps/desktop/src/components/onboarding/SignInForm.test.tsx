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
vi.mock("../../utils/analytics.utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/analytics.utils")>()),
  trackButtonClick: vi.fn(),
  trackOnboardingOutcome: vi.fn(),
  trackOnboardingStep: vi.fn(),
}));
vi.mock("../login/LoginForm", () => ({ LoginForm: () => null }));

import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";
import { SignInForm } from "./SignInForm";

ensureUiHarness();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const state = structuredClone(INITIAL_APP_STATE);
  Object.assign(state.onboarding, {
    name: "",
    firstName: "",
    lastName: "",
    lastNameEnabled: false,
  });
  state.local.onboardingNameDraft = "";
  state.local.onboardingResumePage = null;
  state.auth = {
    uid: "user-id",
    email: "mary@example.com",
    displayName: "Mary Jane Watson",
    providers: ["password"],
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

const renderForm = async () => {
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(SignInForm)));
  });
};

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("SignInForm name editing", () => {
  it("keeps prefilled names editable and preserves middle names", async () => {
    await renderForm();

    const firstNameInput = container.querySelector<HTMLInputElement>(
      'input[autocomplete="given-name"]',
    );
    expect(firstNameInput).not.toBeNull();
    expect(firstNameInput?.required).toBe(true);
    expect(getAppState().onboarding).toMatchObject({
      name: "Mary Jane Watson",
      firstName: "Mary",
      lastName: "Watson",
    });
    expect(getAppState().local.onboardingNameDraft).toBe("Mary Jane Watson");
    expect(getAppState().onboarding.currentPage).toBe("signIn");

    if (!firstNameInput) {
      throw new Error("First-name input was not rendered");
    }
    setInputValue(firstNameInput, "Maria");

    expect(getAppState().onboarding.name).toBe("Maria Jane Watson");
    expect(getAppState().local.onboardingNameDraft).toBe("Maria Jane Watson");

    setInputValue(firstNameInput, "");

    expect(getAppState().onboarding.firstName).toBe("");
    expect(firstNameInput.value).toBe("");
  });

  it("ignores the personal provider placeholder and activates the last-name field", async () => {
    const state = structuredClone(getAppState());
    state.auth = {
      uid: "user-id",
      email: "personal@mausvoice.local",
      displayName: "Personal User",
      providers: ["personal"],
    };
    setAppState(state, true);

    await renderForm();

    const firstNameInput = container.querySelector<HTMLInputElement>(
      'input[autocomplete="given-name"]',
    );
    const lastNameInput = container.querySelector<HTMLInputElement>(
      'input[autocomplete="family-name"]',
    );
    const continueButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Continue");
    expect(firstNameInput?.value).toBe("");
    expect(continueButton?.disabled).toBe(true);
    expect(lastNameInput?.readOnly).toBe(true);
    expect(lastNameInput?.getAttribute("aria-disabled")).toBe("true");
    expect(getAppState().onboarding.name).toBe("");

    if (!firstNameInput || !lastNameInput) {
      throw new Error("Name inputs were not rendered");
    }
    setInputValue(firstNameInput, "Mary");
    act(() => {
      lastNameInput.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true }),
      );
    });

    expect(lastNameInput.readOnly).toBe(false);
    expect(lastNameInput.getAttribute("aria-disabled")).toBe("false");
    expect(getAppState().onboarding.lastNameEnabled).toBe(true);

    setInputValue(lastNameInput, "Watson");
    expect(getAppState().onboarding.name).toBe("Mary Watson");
  });

  it("clears stale last-name state and preserves a later resume page", async () => {
    const state = structuredClone(getAppState());
    state.auth = {
      uid: "user-id",
      email: "mary@example.com",
      displayName: "Mary Jane Watson",
      providers: ["password"],
    };
    state.userById["user-id"] = {
      id: "user-id",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "Mary",
      onboarded: false,
      playInteractionChime: true,
      hasFinishedTutorial: false,
      wordsThisMonth: 0,
      wordsTotal: 0,
    };
    state.local.onboardingNameDraft = "Mary Jane Watson";
    state.local.onboardingResumePage = "tutorial";
    setAppState(state, true);

    await renderForm();

    expect(getAppState().onboarding).toMatchObject({
      name: "Mary",
      firstName: "Mary",
      lastName: "",
      lastNameEnabled: false,
      currentPage: "signIn",
    });
    expect(getAppState().local.onboardingResumePage).toBe("tutorial");
    expect(getAppState().local.onboardingNameDraft).toBe("Mary");
  });
});
