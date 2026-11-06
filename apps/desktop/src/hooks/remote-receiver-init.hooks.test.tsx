// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn<() => Promise<boolean>>(),
  refresh: vi.fn<() => Promise<void>>(),
  start: vi.fn<(port: number | null) => Promise<void>>(),
  repair: vi.fn<(isCurrent: () => boolean) => Promise<void>>(),
  state: {
    authSessionNonce: 0,
    settings: { elevationStartupPending: false },
    pairedRemoteDeviceById: {} as Record<string, object>,
    remoteReceiverStatus: { enabled: false },
    prefs: {
      remoteTargetDeviceId: null as string | null,
      remoteReceiverAutoStart: false,
      remoteReceiverPort: null as number | null,
    },
  },
}));
vi.mock("../actions/paired-remote-device.actions", () => ({
  loadPairedRemoteDevices: mocks.load,
}));
vi.mock("../actions/remote-receiver.actions", () => ({
  refreshRemoteReceiverStatus: mocks.refresh,
  startRemoteReceiver: mocks.start,
}));
vi.mock("../actions/user.actions", () => ({
  clearUnavailableRemoteTarget: mocks.repair,
}));
vi.mock("../utils/user.utils", () => ({
  getMyUserPreferences: () => mocks.state.prefs,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ warning: vi.fn() }),
}));
vi.mock("../store", () => ({ getAppState: () => mocks.state }));
import { useRemoteReceiverInit } from "./remote-receiver-init.hooks";

const deferred = <T = void,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

describe("remote receiver startup ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  const Probe = ({ nonce = 0, ready = true, elevation = true }) => {
    useRemoteReceiverInit(elevation, ready, nonce);
    return null;
  };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.load.mockResolvedValue(true);
    for (const fn of [mocks.refresh, mocks.start, mocks.repair])
      fn.mockResolvedValue(undefined);
    mocks.state.authSessionNonce = 0;
    mocks.state.settings.elevationStartupPending = false;
    mocks.state.pairedRemoteDeviceById = {};
    mocks.state.remoteReceiverStatus = { enabled: false };
    mocks.state.prefs = {
      remoteTargetDeviceId: null,
      remoteReceiverAutoStart: false,
      remoteReceiverPort: null,
    };
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

  it("does not continue an old session after loading paired devices", async () => {
    const pending = deferred<boolean>();
    mocks.load.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.authSessionNonce = 1;
    await act(async () => pending.resolve(true));
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { nonce: 1 })));
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("does not repair a target from a superseded device list", async () => {
    mocks.load.mockResolvedValueOnce(false);
    mocks.state.prefs.remoteTargetDeviceId = "missing";
    await act(async () => root.render(createElement(Probe, {})));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("does not start while the gate or user initialization is closed", async () => {
    await act(async () => root.render(createElement(Probe, { ready: false })));
    await act(async () =>
      root.render(createElement(Probe, { elevation: false })),
    );
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("rechecks the latest autostart preference after repairing a missing target", async () => {
    const pending = deferred();
    mocks.state.prefs = {
      remoteTargetDeviceId: "missing",
      remoteReceiverAutoStart: true,
      remoteReceiverPort: 5555,
    };
    mocks.repair.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe, {})));
    expect(mocks.repair).toHaveBeenCalledWith(expect.any(Function));
    mocks.state.prefs.remoteReceiverAutoStart = false;
    await act(async () => pending.resolve());
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not perform later writes after a session change while repairing a target", async () => {
    const pending = deferred();
    mocks.state.prefs = {
      remoteTargetDeviceId: "missing",
      remoteReceiverAutoStart: true,
      remoteReceiverPort: 5555,
    };
    mocks.repair.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.authSessionNonce = 1;
    await act(async () => pending.resolve());
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("stops when elevation closes during a receiver status refresh", async () => {
    const pending = deferred();
    mocks.refresh.mockReturnValueOnce(pending.promise);
    mocks.state.prefs.remoteReceiverAutoStart = true;
    await act(async () => root.render(createElement(Probe, {})));
    mocks.state.settings.elevationStartupPending = true;
    await act(async () => pending.resolve());
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("does not start a receiver that is already enabled", async () => {
    mocks.state.prefs.remoteReceiverAutoStart = true;
    mocks.state.remoteReceiverStatus.enabled = true;
    await act(async () => root.render(createElement(Probe, {})));
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("starts an opted-in inactive receiver on the configured port", async () => {
    mocks.state.prefs.remoteReceiverAutoStart = true;
    mocks.state.prefs.remoteReceiverPort = 5555;
    await act(async () => root.render(createElement(Probe, {})));
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(5555);
  });
});
