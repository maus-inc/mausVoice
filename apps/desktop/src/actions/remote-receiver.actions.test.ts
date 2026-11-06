import type { RemoteReceiverStatus } from "@maus-inc/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../repos", () => ({
  getRemoteReceiverRepo: () => ({
    getRemoteReceiverStatus: mocks.status,
    startRemoteReceiver: mocks.start,
    stopRemoteReceiver: mocks.stop,
  }),
}));
import {
  refreshRemoteReceiverStatus,
  startRemoteReceiver,
  stopRemoteReceiver,
} from "./remote-receiver.actions";

const status = (enabled: boolean): RemoteReceiverStatus => ({
  enabled,
  deviceId: "device",
  deviceName: "Device",
  devicePlatform: "windows",
  listenAddress: enabled ? "192.168.1.2" : null,
  port: enabled ? 1234 : null,
  pairingCode: "code",
  lastSenderDeviceId: null,
  lastEventId: null,
  lastDeliveryStatus: null,
  lastDeliveryAt: null,
  lastError: null,
  lastTargetClassName: null,
  lastTargetTitle: null,
  lastTargetEditable: null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.resetAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

describe("remote receiver status ownership", () => {
  it("does not restore an old start result after a newer stop", async () => {
    const start = deferred<RemoteReceiverStatus>();
    const stop = deferred<RemoteReceiverStatus>();
    mocks.start.mockReturnValueOnce(start.promise);
    mocks.stop.mockReturnValueOnce(stop.promise);
    const starting = startRemoteReceiver(1234);
    const stopping = stopRemoteReceiver();
    stop.resolve(status(false));
    await stopping;
    start.resolve(status(true));
    await starting;
    expect(getAppState().remoteReceiverStatus).toEqual(status(false));
  });

  it("does not let an old refresh overwrite a completed start", async () => {
    const read = deferred<RemoteReceiverStatus>();
    const start = deferred<RemoteReceiverStatus>();
    mocks.status.mockReturnValueOnce(read.promise);
    mocks.start.mockReturnValueOnce(start.promise);
    const starting = startRemoteReceiver();
    const refreshing = refreshRemoteReceiverStatus();
    start.resolve(status(true));
    await starting;
    read.resolve(status(false));
    await refreshing;
    expect(getAppState().remoteReceiverStatus).toEqual(status(true));
  });

  it("uses the newest refresh if replies arrive out of order", async () => {
    const first = deferred<RemoteReceiverStatus>();
    const second = deferred<RemoteReceiverStatus>();
    mocks.status
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const older = refreshRemoteReceiverStatus();
    const newer = refreshRemoteReceiverStatus();
    second.resolve(status(true));
    await newer;
    first.resolve(status(false));
    await older;
    expect(getAppState().remoteReceiverStatus).toEqual(status(true));
  });

  it("invalidates an in-flight refresh even if the mutation fails", async () => {
    const read = deferred<RemoteReceiverStatus>();
    const start = deferred<RemoteReceiverStatus>();
    mocks.status.mockReturnValueOnce(read.promise);
    mocks.start.mockReturnValueOnce(start.promise);
    const starting = startRemoteReceiver();
    const failed = expect(starting).rejects.toThrow("start failed");
    const refreshing = refreshRemoteReceiverStatus();
    start.reject(new Error("start failed"));
    await failed;
    read.resolve(status(true));
    await refreshing;
    expect(getAppState().remoteReceiverStatus).toBeNull();
  });
});
