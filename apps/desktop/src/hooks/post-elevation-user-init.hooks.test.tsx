// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<void>>(),
  error: vi.fn(),
  state: { authSessionNonce: 0, settings: { elevationStartupPending: false } },
}));
vi.mock("../actions/user.actions", () => ({
  refreshCurrentUser: mocks.refresh,
}));
vi.mock("../store", () => ({ getAppState: () => mocks.state }));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ error: mocks.error }),
}));
import { usePostElevationUserInit } from "./post-elevation-user-init.hooks";

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("post-elevation user initialization", () => {
  let root: Root;
  let container: HTMLDivElement;
  let mounted: boolean;
  const ready = vi.fn();
  const Probe = ({ nonce = 0, auth = true, elevation = true }) => {
    usePostElevationUserInit(elevation, auth, nonce, ready);
    return null;
  };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.state.authSessionNonce = 0;
    mocks.state.settings.elevationStartupPending = false;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mounted = true;
  });
  afterEach(async () => {
    if (mounted) await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("does not let an old refresh initialize a changed identity, even before rerender", async () => {
    const first = deferred();
    const second = deferred();
    mocks.refresh
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.authSessionNonce = 1;
    await act(async () => first.resolve());
    expect(ready).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { nonce: 1 })));
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve());
    expect(ready).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("ignores a superseded or unmounted refresh", async () => {
    const first = deferred();
    const second = deferred();
    mocks.refresh
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.authSessionNonce = 1;
    await act(async () => root.render(createElement(Probe, { nonce: 1 })));
    await act(async () => first.resolve());
    expect(ready).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
      mounted = false;
    });
    await act(async () => second.resolve());
    expect(ready).not.toHaveBeenCalled();
  });

  it("serializes refreshes and skips a session superseded while waiting", async () => {
    const first = deferred();
    const last = deferred();
    mocks.refresh
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(last.promise);
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.authSessionNonce = 1;
    await act(async () => root.render(createElement(Probe, { nonce: 1 })));
    mocks.state.authSessionNonce = 2;
    await act(async () => root.render(createElement(Probe, { nonce: 2 })));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve());
    expect(ready).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    await act(async () => last.resolve());
    expect(ready).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not initialize while elevation is pending or authentication is not ready", async () => {
    mocks.refresh.mockResolvedValue();
    await act(async () => root.render(createElement(Probe, { auth: false })));
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () =>
      root.render(createElement(Probe, { elevation: false })),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    const pending = deferred();
    mocks.refresh.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.settings.elevationStartupPending = true;
    await act(async () => pending.resolve());
    expect(ready).not.toHaveBeenCalled();
  });

  it("still initializes after a failed refresh for the current session", async () => {
    mocks.refresh.mockRejectedValue(new Error("failed"));
    await act(async () => root.render(createElement(Probe, {})));
    expect(mocks.error).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledExactlyOnceWith(true);
  });
});
