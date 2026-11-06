// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  register_once: vi.fn(),
  people: { set: vi.fn(), set_once: vi.fn() },
}));
vi.mock("../utils/analytics.utils", async (original) => ({
  ...(await original<typeof import("../utils/analytics.utils")>()),
  getMixpanel: () => mocks,
}));
vi.mock("../utils/platform.utils", () => ({ getPlatform: () => "linux" }));
vi.mock("../i18n", () => ({
  detectLocale: () => "en",
  getIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
import { useAnalyticsIdentity } from "./analytics-identity.hooks";

const auth = (uid: string) => ({
  uid,
  email: `${uid}@example.com`,
  displayName: uid,
  providers: [],
});
const version = {
  state: "success" as const,
  data: "1.2.3",
  refresh: async () => {},
};

describe("analytics identity ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  const Probe = ({
    uid,
    initialized = true,
  }: {
    uid: string | null;
    initialized?: boolean;
  }) => {
    useAnalyticsIdentity({
      initialized,
      auth: uid ? auth(uid) : null,
      member: null,
      localUser: null,
      preferences: null,
      versionData: version,
    });
    return null;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("identifies a user only once while refreshing profile data", async () => {
    await act(async () => root.render(createElement(Probe, { uid: "a" })));
    await act(async () => root.render(createElement(Probe, { uid: "a" })));
    expect(mocks.identify).toHaveBeenCalledExactlyOnceWith("a");
    expect(mocks.people.set_once).toHaveBeenCalledOnce();
    expect(mocks.register_once).toHaveBeenCalledOnce();
    expect(mocks.register).toHaveBeenCalledWith({ appVersion: "1.2.3" });
  });

  it("resets the previous identity before directly switching users", async () => {
    await act(async () => root.render(createElement(Probe, { uid: "a" })));
    await act(async () => root.render(createElement(Probe, { uid: "b" })));
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.identify.mock.calls).toEqual([["a"], ["b"]]);
    expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.identify.mock.invocationCallOrder[1],
    );
    expect(mocks.register_once).toHaveBeenCalledTimes(2);
  });

  it("retires the old identity immediately during reinitialization", async () => {
    await act(async () => root.render(createElement(Probe, { uid: "a" })));
    await act(async () =>
      root.render(createElement(Probe, { uid: "b", initialized: false })),
    );
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.identify.mock.calls).toEqual([["a"]]);
    await act(async () => root.render(createElement(Probe, { uid: "b" })));
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.identify.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("resets on logout and waits until initialization before tracking", async () => {
    await act(async () =>
      root.render(createElement(Probe, { uid: "a", initialized: false })),
    );
    expect(mocks.identify).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { uid: "a" })));
    await act(async () => root.render(createElement(Probe, { uid: null })));
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.identify).toHaveBeenCalledOnce();
  });
});
