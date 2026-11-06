// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  restart: vi.fn().mockResolvedValue(true),
  snackbar: vi.fn(),
  authorized: vi.fn(() => true),
  logger: { info: vi.fn(), warning: vi.fn() },
}));
vi.mock("../actions/app.actions", () => ({ showSnackbar: mocks.snackbar }));
vi.mock("../actions/windows-sync.actions", () => ({
  restartKeyboardListenerOnResume: mocks.restart,
}));
vi.mock("../utils/permission.utils", () => ({
  isPermissionAuthorized: mocks.authorized,
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (event: string, listener: (payload: never) => void) =>
    mocks.listeners.set(event, listener),
}));
import { useKeyboardListenerEvents } from "./keyboard-listener-events.hooks";

const intl = createIntl({ locale: "en" });
intl.formatMessage = ((message: { defaultMessage?: string }) =>
  message.defaultMessage ?? "") as typeof intl.formatMessage;
const Probe = ({ main }: { main: boolean }) => {
  useKeyboardListenerEvents({ isMainWindow: main, intl });
  return null;
};

describe("keyboard listener events", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.authorized.mockReturnValue(true);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });

  it("notifies once per failure episode and resets after recovery", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    const health = mocks.listeners.get("keyboard_listener_health")!;
    health({ state: "failed" } as never);
    health({ state: "stopped" } as never);
    health({ state: "failed" } as never);
    expect(mocks.snackbar).toHaveBeenCalledTimes(1);
    health({ state: "healthy_grab" } as never);
    health({ state: "failed" } as never);
    expect(mocks.snackbar).toHaveBeenCalledTimes(2);
    expect(getAppState().keyboardListenerHealth).toBe("failed");
  });

  it("does not show a hotkey failure toast without permission", async () => {
    mocks.authorized.mockReturnValue(false);
    await act(async () => root.render(createElement(Probe, { main: true })));
    mocks.listeners.get("keyboard_listener_health")?.({
      state: "failed",
    } as never);
    expect(mocks.snackbar).not.toHaveBeenCalled();
    expect(getAppState().keyboardListenerHealth).toBe("failed");
  });

  it("passes current strategy, permission and window ownership to resume", async () => {
    await act(async () => root.render(createElement(Probe, { main: false })));
    setAppState({ hotkeyStrategy: "listener" });
    await act(async () =>
      mocks.listeners.get("desktop_resume")?.(undefined as never),
    );
    expect(mocks.restart).toHaveBeenCalledWith({
      hotkeyStrategy: "listener",
      isMainWindow: false,
      keyPermAuthorized: true,
    });
  });
});
