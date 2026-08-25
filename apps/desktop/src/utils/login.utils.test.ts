import { describe, expect, it, vi } from "vitest";

vi.mock("../i18n/intl", () => ({
  getIntl: () => ({
    formatMessage: (msg: { defaultMessage?: string; id?: string }) =>
      msg.defaultMessage ?? msg.id ?? "",
  }),
}));

import type { AppState } from "../state/app.state";
import { INITIAL_LOGIN_STATE } from "../state/login.state";
import {
  getCanSubmitSignUp,
  getSignUpConfirmPasswordValidation,
  validateConfirmPassword,
} from "./login.utils";

const makeState = (overrides: Partial<AppState["login"]> = {}): AppState =>
  ({
    login: {
      ...INITIAL_LOGIN_STATE,
      ...overrides,
    },
  }) as AppState;

describe("validateConfirmPassword", () => {
  it("returns null when the confirmation matches the password", () => {
    const state = makeState({ password: "secret", confirmPassword: "secret" });
    expect(validateConfirmPassword(state)).toBeNull();
  });

  it("returns an error message when the confirmation differs from the password", () => {
    const state = makeState({ password: "secret", confirmPassword: "other" });
    expect(validateConfirmPassword(state)).toBe("Password does not match");
  });

  it("returns null when the confirmation is empty", () => {
    const state = makeState({ password: "secret", confirmPassword: "" });
    expect(validateConfirmPassword(state)).toBeNull();
  });
});

describe("getSignUpConfirmPasswordValidation", () => {
  it("does not show an error before submit when only the password is typed", () => {
    const state = makeState({ password: "secret", confirmPassword: "" });
    expect(getSignUpConfirmPasswordValidation(state)).toBeNull();
  });

  it("does not show an error before submit when only the confirmation is typed", () => {
    const state = makeState({ password: "", confirmPassword: "secret" });
    expect(getSignUpConfirmPasswordValidation(state)).toBeNull();
  });

  it("shows a mismatch error live once both fields are typed and they differ", () => {
    const state = makeState({
      password: "secret",
      confirmPassword: "different",
    });
    expect(getSignUpConfirmPasswordValidation(state)).toBe(
      "Password does not match",
    );
  });

  it("returns null live once both fields are typed and they match", () => {
    const state = makeState({
      password: "secret",
      confirmPassword: "secret",
    });
    expect(getSignUpConfirmPasswordValidation(state)).toBeNull();
  });

  it("keeps showing the mismatch error after the first submit attempt", () => {
    const state = makeState({
      password: "secret",
      confirmPassword: "different",
      hasSubmittedRegistration: true,
    });
    expect(getSignUpConfirmPasswordValidation(state)).toBe(
      "Password does not match",
    );
  });

  it("does not surface the error after submit when only the password is typed", () => {
    const state = makeState({
      password: "secret",
      confirmPassword: "",
      hasSubmittedRegistration: true,
    });
    expect(getSignUpConfirmPasswordValidation(state)).toBeNull();
  });
});

describe("getCanSubmitSignUp with confirm password", () => {
  it("blocks submit when live-validated passwords mismatch", () => {
    const state = makeState({
      email: "user@example.com",
      password: "secret",
      confirmPassword: "different",
    });
    expect(getCanSubmitSignUp(state)).toBe(false);
  });

  it("allows submit when both password fields match", () => {
    const state = makeState({
      email: "user@example.com",
      password: "secret",
      confirmPassword: "secret",
    });
    expect(getCanSubmitSignUp(state)).toBe(true);
  });
});
