// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState } from "../../store";

const actions = vi.hoisted(() => ({
  setMode: vi.fn(),
  submitSignIn: vi.fn(),
  submitSignUp: vi.fn(),
}));
vi.mock("../../actions/login.actions", () => actions);
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { SignInForm } from "./SignInForm";
import { SignUpForm } from "./SignUpForm";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  vi.clearAllMocks();
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

const change = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("login credential fields", () => {
  it.each(["sign in", "sign up"])(
    "updates shared credentials in %s",
    async (mode) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(mode === "sign in" ? <SignInForm /> : <SignUpForm />),
        );
        const email = container.querySelector<HTMLInputElement>(
          'input[type="email"]',
        )!;
        const password = container.querySelector<HTMLInputElement>(
          'input[type="password"]',
        )!;
        await change(email, "person@example.com");
        await change(password, "secret123");
        expect(getAppState().login.email).toBe("person@example.com");
        expect(getAppState().login.password).toBe("secret123");
        const toggle = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Show password"]',
        )!;
        await act(async () => toggle.click());
        expect(password.type).toBe("text");
        if (mode === "sign up") {
          const confirmation = container.querySelector<HTMLInputElement>(
            'input[type="password"]',
          )!;
          expect(confirmation).not.toBe(password);
          await change(confirmation, "secret123");
          expect(getAppState().login.confirmPassword).toBe("secret123");
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    },
  );
});
