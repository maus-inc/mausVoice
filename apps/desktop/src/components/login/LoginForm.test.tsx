// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import type { LoginMode } from "../../state/login.state";
import { getAppState, setAppState } from "../../store";
import { LoginForm } from "./LoginForm";

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("./SignInForm", () => ({
  SignInForm: () => <div data-form="signIn" />,
}));
vi.mock("./SignUpForm", () => ({
  SignUpForm: ({ hideModeSwitch }: { hideModeSwitch?: boolean }) => (
    <div data-form="signUp" data-hide-switch={String(hideModeSwitch)} />
  ),
}));
vi.mock("./ResetPasswordForm", () => ({
  ResetPasswordForm: () => <div data-form="resetPassword" />,
}));
vi.mock("./ResetSentForm", () => ({
  ResetSentForm: () => <div data-form="passwordResetSent" />,
}));
vi.mock("./TermsNotice", () => ({ TermsNotice: () => <div>Terms</div> }));
ensureUiHarness();

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

const render = async (mode: LoginMode, path = "/", hideModeSwitch = false) => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <LoginForm defaultMode={mode} hideModeSwitch={hideModeSwitch} />
      </MemoryRouter>,
    ),
  );
};

describe("LoginForm modes", () => {
  it.each([
    ["signIn", "Sign in"],
    ["signUp", "Sign up"],
    ["resetPassword", "Reset password"],
    ["passwordResetSent", "Email sent"],
  ] as const)(
    "renders the title and matching form for %s",
    async (mode, title) => {
      await render(mode, "/", true);
      expect(container.textContent).toContain(title);
      expect(container.querySelector(`[data-form="${mode}"]`)).not.toBeNull();
      if (mode === "signUp")
        expect(
          container
            .querySelector('[data-form="signUp"]')
            ?.getAttribute("data-hide-switch"),
        ).toBe("true");
      expect(container.textContent).toContain("Terms");
    },
  );

  it.each([
    ["register", "signUp", "Sign up"],
    ["login", "signIn", "Sign in"],
  ] as const)(
    "consumes %s query mode and persists it over the default",
    async (query, mode, title) => {
      await render("resetPassword", `/?mode=${query}`);
      expect(getAppState().login.mode).toBe(mode);
      expect(container.textContent).toContain(title);
      expect(container.querySelector(`[data-form="${mode}"]`)).not.toBeNull();
    },
  );

  it("ignores an unknown query mode and retains the default", async () => {
    await render("resetPassword", "/?mode=unknown");
    expect(getAppState().login.mode).toBe("resetPassword");
    expect(container.textContent).toContain("Reset password");
  });
});
