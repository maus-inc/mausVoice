import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { produceAppState, setAppState } from "../store";
import { captureUserSession, requireUserSession } from "./user-session.utils";

const user = (uid: string) => ({
  uid,
  email: `${uid}@example.com`,
  displayName: uid,
  providers: ["password"],
});

const signIn = (uid: string) => {
  produceAppState((state) => {
    state.auth = user(uid);
    state.authSessionNonce += 1;
  });
};

describe("captureUserSession", () => {
  beforeEach(() => {
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("stays current while the same session is signed in", () => {
    signIn("alice");
    const isCurrent = captureUserSession();

    expect(isCurrent()).toBe(true);
  });

  it("retires when a different user signs in", () => {
    signIn("alice");
    const isCurrent = captureUserSession();
    signIn("bob");

    expect(isCurrent()).toBe(false);
  });

  it("retires when the same user signs in again", () => {
    // A same-user re-login keeps the uid but must invalidate work that started
    // under the previous sign-in, which is what the nonce is for.
    signIn("alice");
    const isCurrent = captureUserSession();
    signIn("alice");

    expect(isCurrent()).toBe(false);
  });

  it("retires on sign-out", () => {
    signIn("alice");
    const isCurrent = captureUserSession();
    produceAppState((state) => {
      state.auth = null;
      state.authSessionNonce += 1;
    });

    expect(isCurrent()).toBe(false);
  });

  it("treats a signed-out start as current only while still signed out", () => {
    const isCurrent = captureUserSession();

    expect(isCurrent()).toBe(true);
    signIn("alice");
    expect(isCurrent()).toBe(false);
  });

  it("ignores unrelated state changes", () => {
    signIn("alice");
    const isCurrent = captureUserSession();
    produceAppState((state) => {
      state.settings.hotkeysStatus = "error";
    });

    expect(isCurrent()).toBe(true);
  });
});

describe("requireUserSession", () => {
  it("throws the message the callers report", () => {
    expect(() => requireUserSession(() => true)).not.toThrow();
    expect(() => requireUserSession(() => false)).toThrow(
      "User session changed",
    );
  });
});
