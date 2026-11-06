// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { firstValueFrom, type Observable } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  stream: null as null | {
    builder: () => Observable<unknown>;
    onSuccess: (value: unknown) => void;
  },
  member: vi.fn(),
  user: vi.fn(),
  registerMembers: vi.fn(),
  registerUsers: vi.fn(),
}));
vi.mock("../repos", () => ({
  getMemberRepo: () => ({ getMyMember: mocks.member }),
  getUserRepo: () => ({ getMyUser: mocks.user }),
}));
vi.mock("../utils/app.utils", () => ({
  registerMembers: mocks.registerMembers,
  registerUsers: mocks.registerUsers,
}));
vi.mock("./stream.hooks", () => ({
  useStreamWithSideEffects: (options: typeof mocks.stream) => {
    mocks.stream = options;
  },
}));
import { useAuthenticatedProfileStream } from "./authenticated-profile-stream.hooks";

const setStreamReady = vi.fn();
const Probe = ({
  authReady,
  userId = "alice",
  nonce = 0,
}: {
  authReady: boolean;
  userId?: string;
  nonce?: number;
}) => {
  useAuthenticatedProfileStream({
    elevationReady: true,
    authReady,
    userId,
    authSessionNonce: nonce,
    setStreamReady,
  });
  return null;
};

describe("authenticated profile loading", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stream = null;
    mocks.member.mockResolvedValue(null);
    mocks.user.mockResolvedValue(null);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    setAppState({
      settings: {
        ...INITIAL_APP_STATE.settings,
        elevationStartupPending: false,
      },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });
  it("does not mark the profile ready while authentication is unresolved", async () => {
    await act(async () =>
      root.render(createElement(Probe, { authReady: false })),
    );
    expect(await firstValueFrom(mocks.stream!.builder())).toBeNull();
    mocks.stream!.onSuccess(null);
    expect(setStreamReady).not.toHaveBeenCalled();
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("ignores results for a retired auth session", async () => {
    await act(async () =>
      root.render(createElement(Probe, { authReady: true })),
    );
    setAppState({ authSessionNonce: 1 });
    mocks.stream!.onSuccess([null, null]);
    expect(setStreamReady).not.toHaveBeenCalled();
    expect(mocks.registerUsers).not.toHaveBeenCalled();
  });
  it("loads and applies current session results after auth resolves", async () => {
    await act(async () =>
      root.render(createElement(Probe, { authReady: true })),
    );
    const result = await firstValueFrom(mocks.stream!.builder());
    expect(mocks.member).toHaveBeenCalledOnce();
    expect(mocks.user).toHaveBeenCalledOnce();
    mocks.stream!.onSuccess(result);
    expect(setStreamReady).toHaveBeenCalledWith(true);
    expect(mocks.registerMembers).toHaveBeenCalledOnce();
    expect(mocks.registerUsers).toHaveBeenCalledOnce();
  });
});
