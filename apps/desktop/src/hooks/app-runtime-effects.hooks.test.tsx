// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => Promise<void>>(),
  handle: vi.fn((_payload: unknown, _isCurrent: () => boolean): Promise<void> =>
    Promise.resolve(),
  ),
  refresh: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  hotkeys: vi.fn(),
  keyboard: vi.fn(),
  overlay: vi.fn(),
  capabilities: vi.fn(),
  feedback: vi.fn(),
  nativeKeyboard: vi.fn(),
}));
vi.mock("../actions/remote-receiver.actions", () => ({
  refreshRemoteReceiverStatus: mocks.refresh,
}));
vi.mock("../actions/remote-transcript.actions", () => ({
  handleRemoteFinalTextReceived: mocks.handle,
}));
vi.mock("./app-startup.hooks", () => ({ useAppStartup: mocks.start }));
vi.mock("./hotkey-input-events.hooks", () => ({
  useHotkeyInputEvents: mocks.hotkeys,
}));
vi.mock("./keyboard-listener-events.hooks", () => ({
  useKeyboardListenerEvents: mocks.keyboard,
}));
vi.mock("./native-capabilities.hooks", () => ({
  useNativeCapabilities: mocks.capabilities,
}));
vi.mock("./native-feedback-sync.hooks", () => ({
  useNativeFeedbackSync: mocks.feedback,
}));
vi.mock("./native-keyboard-listener.hooks", () => ({
  useNativeKeyboardListener: mocks.nativeKeyboard,
}));
vi.mock("./overlay-state-events.hooks", () => ({
  useOverlayStateEvents: mocks.overlay,
}));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (
    event: string,
    listener: (payload: never) => Promise<void>,
  ) => mocks.listeners.set(event, listener),
}));
import { useAppRuntimeEffects } from "./app-runtime-effects.hooks";

const intl = createIntl({ locale: "en" });
const Probe = ({ main }: { main: boolean }) => {
  useAppRuntimeEffects({ isMainWindow: main, intl });
  return null;
};
describe("application runtime ownership", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handle.mockResolvedValue(undefined);
    mocks.listeners.clear();
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });
  it("processes remote final text only in the main window and refreshes receiver state", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    const payload = {
      senderDeviceId: "a",
      eventId: "b",
      text: "hello",
      mode: "dictate",
      createdAt: "now",
    };
    await mocks.listeners.get("remote_final_text_received")!(payload as never);
    expect(mocks.handle).toHaveBeenCalledWith(payload, expect.any(Function));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(true);
    expect(mocks.nativeKeyboard).toHaveBeenCalledWith(
      expect.objectContaining({ isMainWindow: true }),
    );
    await act(async () => root.render(createElement(Probe, { main: false })));
    await mocks.listeners.get("remote_final_text_received")!(payload as never);
    expect(mocks.handle).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("retires in-flight delivery on an authentication change", async () => {
    let finish!: () => void;
    mocks.handle.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => root.render(createElement(Probe, { main: true })));
    const delivery = mocks.listeners.get("remote_final_text_received")!(
      {} as never,
    );
    const guard = mocks.handle.mock.calls[0][1];
    expect(guard()).toBe(true);
    setAppState({ authSessionNonce: 1 });
    expect(guard()).toBe(false);
    finish();
    await delivery;
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("retires in-flight delivery and queued callbacks on unmount", async () => {
    let finish!: () => void;
    mocks.handle.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => root.render(createElement(Probe, { main: true })));
    const listener = mocks.listeners.get("remote_final_text_received")!;
    const delivery = listener({} as never);
    const guard = mocks.handle.mock.calls[0][1];
    await act(async () => root.unmount());
    expect(guard()).toBe(false);
    await listener({} as never);
    expect(mocks.handle).toHaveBeenCalledOnce();
    finish();
    await delivery;
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
