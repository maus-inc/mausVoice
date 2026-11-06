// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  label: "main",
  refresh: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  onDisconnectRemove: vi.fn(),
  onValue: vi.fn(
    (
      _ref: { path: string },
      _callback: (snapshot: { val: () => unknown }) => void,
    ) =>
      () => {},
  ),
  handle: vi.fn(),
  toast: vi.fn(),
  warning: vi.fn(),
  interval: vi.fn(
    (_delay: number, _callback: () => Promise<void>, _deps: unknown[]) => {},
  ),
  state: {
    initialized: true,
    authSessionNonce: 0,
    auth: { uid: "user" },
    remoteReceiverStatus: { deviceId: "device", deviceName: "Desktop" },
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.label }),
}));
vi.mock("firebase/database", () => ({
  getDatabase: () => ({}),
  ref: (_db: unknown, path: string) => ({ path }),
  set: mocks.set,
  remove: mocks.remove,
  update: mocks.update,
  onDisconnect: () => ({ remove: mocks.onDisconnectRemove }),
  onValue: mocks.onValue,
}));
vi.mock("../../actions/remote-receiver.actions", () => ({
  refreshRemoteReceiverStatus: mocks.refresh,
}));
vi.mock("../../actions/remote-transcript.actions", () => ({
  handleRemoteFinalTextReceived: mocks.handle,
}));
vi.mock("../../actions/app.actions", () => ({ showSnackbar: mocks.toast }));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({ info: vi.fn(), warning: mocks.warning }),
}));
vi.mock("../../store", () => ({
  getAppState: () => mocks.state,
  useAppStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));
vi.mock("../../hooks/helper.hooks", () => ({
  useIntervalAsync: mocks.interval,
}));
import { SessionSideEffects } from "./SessionSideEffects";

let roots: Root[];
let containers: HTMLDivElement[];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.label = "main";
  mocks.state.authSessionNonce = 0;
  mocks.refresh.mockResolvedValue(undefined);
  mocks.set.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.onDisconnectRemove.mockResolvedValue(undefined);
  mocks.onValue.mockReturnValue(vi.fn());
  mocks.handle.mockResolvedValue(undefined);
  roots = [];
  containers = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    roots.forEach((root) => root.unmount());
  });
  containers.forEach((container) => container.remove());
  vi.unstubAllGlobals();
});

const mount = async (label: string) => {
  mocks.label = label;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(createElement(SessionSideEffects));
  });
  return root;
};

it("publishes and removes the device session only from the main window", async () => {
  await mount("main");
  await vi.waitFor(() => expect(mocks.onValue).toHaveBeenCalledTimes(2));
  await mount("composer-popout");
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.set).toHaveBeenCalledOnce();
  expect(mocks.onDisconnectRemove).toHaveBeenCalledOnce();
  expect(mocks.onValue).toHaveBeenCalledTimes(2);
  await act(async () => {
    roots[1].unmount();
  });
  roots.splice(1, 1);
  expect(mocks.remove).not.toHaveBeenCalled();
  await act(async () => {
    roots[0].unmount();
  });
  roots.splice(0, 1);
  await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
});

it("does not publish a session from a secondary window by itself", async () => {
  await mount("composer-popout");
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.onDisconnectRemove).not.toHaveBeenCalled();
  expect(mocks.onValue).not.toHaveBeenCalled();
});

it("does not publish a session after its window unmounts during status refresh", async () => {
  let finish!: () => void;
  mocks.refresh.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await mount("main");
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await act(async () => {
    roots[0].unmount();
  });
  roots.splice(0, 1);
  await act(async () => finish());
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.onValue).not.toHaveBeenCalled();
});

it("does not paste into a later session when acknowledgement completes after unmount", async () => {
  let finish!: () => void;
  mocks.update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await mount("main");
  await vi.waitFor(() => expect(mocks.onValue).toHaveBeenCalledTimes(2));
  const subscription = mocks.onValue.mock.calls.find(([reference]) =>
    reference.path.startsWith("session/"),
  );
  if (!subscription) throw new Error("Session subscription missing");
  const callback = subscription[1] as (snapshot: {
    val: () => unknown;
  }) => void;
  await act(async () =>
    callback({
      val: () => ({ pasteText: "private", pasteTimestamp: Date.now() + 1000 }),
    }),
  );
  expect(mocks.update).toHaveBeenCalledOnce();
  await act(async () => {
    roots[0].unmount();
  });
  roots.splice(0, 1);
  await act(async () => finish());
  expect(mocks.handle).not.toHaveBeenCalled();
});

it("waits for actual insertion and does not show a second success toast", async () => {
  await mount("main");
  await vi.waitFor(() => expect(mocks.onValue).toHaveBeenCalledTimes(2));
  const subscription = mocks.onValue.mock.calls.find(([reference]) =>
    reference.path.startsWith("session/"),
  );
  if (!subscription) throw new Error("Session subscription missing");
  const callback = subscription[1] as (snapshot: {
    val: () => unknown;
  }) => void;
  await act(async () =>
    callback({
      val: () => ({ pasteText: "hello", pasteTimestamp: Date.now() + 1000 }),
    }),
  );
  await vi.waitFor(() => expect(mocks.handle).toHaveBeenCalledOnce());
  expect(mocks.handle).toHaveBeenCalledWith(
    expect.objectContaining({ text: "hello", senderDeviceId: "device" }),
    expect.any(Function),
  );
  expect(mocks.toast).not.toHaveBeenCalled();
});

it("rejects a delayed paste from an earlier login even before React rerenders", async () => {
  let finish!: () => void;
  mocks.update.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  await mount("main");
  await vi.waitFor(() => expect(mocks.onValue).toHaveBeenCalledTimes(2));
  const subscription = mocks.onValue.mock.calls.find(([reference]) =>
    reference.path.startsWith("session/"),
  );
  if (!subscription) throw new Error("Session subscription missing");
  const callback = subscription[1];
  await act(async () =>
    callback({
      val: () => ({ pasteText: "private", pasteTimestamp: Date.now() + 1000 }),
    }),
  );
  mocks.state.authSessionNonce += 1;
  await act(async () => finish());
  expect(mocks.handle).not.toHaveBeenCalled();
});

it("does not heartbeat a retired authentication session before React rerenders", async () => {
  await mount("main");
  await vi.waitFor(() => expect(mocks.onValue).toHaveBeenCalledTimes(2));
  const heartbeat = mocks.interval.mock.lastCall?.[1];
  if (!heartbeat) throw new Error("Heartbeat callback missing");
  await heartbeat();
  expect(mocks.update).toHaveBeenCalledOnce();
  mocks.state.authSessionNonce += 1;
  await heartbeat();
  expect(mocks.update).toHaveBeenCalledOnce();
});

it("handles insertion failures without reporting a false success", async () => {
  mocks.handle.mockRejectedValueOnce(new Error("private failure details"));
  await mount("main");
  await vi.waitFor(() => expect(mocks.onValue).toHaveBeenCalledTimes(2));
  const subscription = mocks.onValue.mock.calls.find(([reference]) =>
    reference.path.startsWith("session/"),
  );
  if (!subscription) throw new Error("Session subscription missing");
  await act(async () =>
    subscription[1]({
      val: () => ({ pasteText: "private", pasteTimestamp: Date.now() + 1000 }),
    }),
  );
  await vi.waitFor(() =>
    expect(mocks.warning).toHaveBeenCalledWith(
      "Could not process remote session text",
    ),
  );
  expect(mocks.toast).not.toHaveBeenCalled();
});
