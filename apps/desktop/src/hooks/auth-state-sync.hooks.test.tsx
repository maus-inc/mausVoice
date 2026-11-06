// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import type { AuthUser } from "../types/auth.types";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  error: vi.fn(),
  logger: { info: vi.fn(), warning: vi.fn() },
}));
vi.mock("../repos", () => ({
  getAuthRepo: () => ({ onAuthStateChanged: mocks.subscribe }),
}));
vi.mock("../actions/app.actions", () => ({ showErrorSnackbar: mocks.error }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import { useAuthStateSync } from "./auth-state-sync.hooks";

const user = (uid: string): AuthUser => ({
  uid,
  email: null,
  displayName: null,
  providers: [],
});
const setAuthReady = vi.fn();
const setInitReady = vi.fn();
const setStreamReady = vi.fn();
const Probe = ({ ready }: { ready: boolean }) => {
  useAuthStateSync({
    elevationReady: ready,
    setAuthReady,
    setInitReady,
    setStreamReady,
  });
  return null;
};

describe("auth subscription ownership", () => {
  let root: Root;
  let change: (value: AuthUser | null) => void;
  let error: (value: unknown) => void;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    mocks.subscribe.mockImplementation((onChange, onError) => {
      change = onChange;
      error = onError;
      return mocks.unsubscribe;
    });
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
  });

  it("ignores late callbacks and errors after elevation closes the subscription", async () => {
    await act(async () => root.render(createElement(Probe, { ready: false })));
    expect(mocks.subscribe).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { ready: true })));
    await act(async () => change(user("alice")));
    expect(getAppState().auth?.uid).toBe("alice");
    await act(async () => root.render(createElement(Probe, { ready: false })));
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    await act(async () => {
      change(user("late"));
      error(new Error("late"));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getAppState().auth?.uid).toBe("alice");
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("releases a pre-auth submission flag on initial identity resolution without losing the draft", async () => {
    setAppState((state) => ({
      onboarding: {
        ...state.onboarding,
        submitting: true,
        dictationOverrideEnabled: true,
      },
      local: { ...state.local, onboardingNameDraft: "Saved draft" },
    }));
    await act(async () => root.render(createElement(Probe, { ready: true })));
    const nonce = getAppState().authSessionNonce;
    await act(async () => change(user("alice")));
    expect(getAppState().authSessionNonce).toBe(nonce);
    expect(getAppState().onboarding.submitting).toBe(false);
    expect(getAppState().onboarding.dictationOverrideEnabled).toBe(false);
    expect(getAppState().local.onboardingNameDraft).toBe("Saved draft");
  });

  it("retires transient retranscription UI when the identity changes", async () => {
    await act(async () => root.render(createElement(Probe, { ready: true })));
    await act(async () => change(user("alice")));
    setAppState((state) => ({
      transcriptions: {
        ...state.transcriptions,
        retranscribingIds: ["old"],
        retranscriptionSuccessIds: ["done"],
      },
    }));
    await act(async () => change(user("bob")));
    expect(getAppState().transcriptions.retranscribingIds).toEqual([]);
    expect(getAppState().transcriptions.retranscriptionSuccessIds).toEqual([]);
  });

  it("keeps an in-flight retranscription on a same-identity auth refresh", async () => {
    await act(async () => root.render(createElement(Probe, { ready: true })));
    await act(async () => change(user("alice")));
    setAppState((state) => ({
      transcriptions: { ...state.transcriptions, retranscribingIds: ["live"] },
    }));
    await act(async () => change(user("alice")));
    expect(getAppState().transcriptions.retranscribingIds).toEqual(["live"]);
  });

  it("times out once and treats a later sign-in as a new auth session", async () => {
    await act(async () => root.render(createElement(Probe, { ready: true })));
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(setAuthReady).toHaveBeenCalledWith(true);
    expect(getAppState().auth).toBeNull();
    const nonce = getAppState().authSessionNonce;
    await act(async () => change(user("alice")));
    expect(getAppState().auth?.uid).toBe("alice");
    expect(getAppState().authSessionNonce).toBe(nonce + 1);
    expect(setInitReady).toHaveBeenCalledWith(false);
    expect(setStreamReady).toHaveBeenCalledWith(false);
  });

  it("surfaces synchronous subscription failure and resolves auth without leaking the timer", async () => {
    const failure = new Error("subscription failed");
    mocks.subscribe.mockImplementation(() => {
      throw failure;
    });
    await act(async () => root.render(createElement(Probe, { ready: true })));
    expect(mocks.error).toHaveBeenCalledWith(failure);
    expect(setAuthReady).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
