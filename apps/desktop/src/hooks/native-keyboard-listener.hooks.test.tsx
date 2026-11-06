// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  logger: { info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("../utils/keyboard.utils", async (original) => ({
  ...(await original<typeof import("../utils/keyboard.utils")>()),
  syncHotkeyCombosToNative: mocks.sync,
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import { useNativeKeyboardListener } from "./native-keyboard-listener.hooks";

const Probe = ({
  main,
  authorized,
}: {
  main: boolean;
  authorized: boolean;
}) => {
  useNativeKeyboardListener({
    isMainWindow: main,
    hotkeyStrategy: "listener",
    keyPermAuthorized: authorized,
  });
  return null;
};

describe("native keyboard listener lifecycle", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
    mocks.sync.mockResolvedValue(undefined);
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    setAppState({ hotkeyStrategy: "listener" });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });

  it("does not commit stale listener health when permission changes mid-start", async () => {
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "start_key_listener") return started;
      if (command === "get_key_listener_health")
        return Promise.resolve("stopped");
      return Promise.resolve(undefined);
    });
    await act(async () =>
      root.render(createElement(Probe, { main: true, authorized: true })),
    );
    await act(async () =>
      root.render(createElement(Probe, { main: true, authorized: false })),
    );
    await act(async () => {
      finish();
      await started;
    });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("stop_key_listener"),
    );
    expect(
      mocks.invoke.mock.calls.filter(
        ([name]) => name === "get_key_listener_health",
      ),
    ).toHaveLength(1);
    expect(getAppState().keyboardListenerHealth).toBe("stopped");
  });

  it("does not publish a health response that resolves after its owner retires", async () => {
    let resolveHealth!: (health: string) => void;
    let healthStarted!: () => void;
    const healthPending = new Promise<string>((resolve) => {
      resolveHealth = resolve;
    });
    const healthRead = new Promise<void>((resolve) => {
      healthStarted = resolve;
    });
    let reads = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_key_listener_health" && reads++ === 0) {
        healthStarted();
        return healthPending;
      }
      if (command === "get_key_listener_health")
        return Promise.resolve("stopped");
      return Promise.resolve(undefined);
    });
    await act(async () =>
      root.render(createElement(Probe, { main: true, authorized: true })),
    );
    await healthRead;
    await act(async () =>
      root.render(createElement(Probe, { main: true, authorized: false })),
    );
    await act(async () => {
      resolveHealth("failed");
      await healthPending;
    });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("stop_key_listener"),
    );
    expect(getAppState().keyboardListenerHealth).toBe("stopped");
  });

  it("never starts or synchronizes the listener in a secondary window", async () => {
    await act(async () =>
      root.render(createElement(Probe, { main: false, authorized: true })),
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("synchronizes grabs for relevant state changes but not unrelated changes", async () => {
    await act(async () =>
      root.render(createElement(Probe, { main: true, authorized: true })),
    );
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    setAppState({ activeRecordingMode: "dictate" });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    setAppState({ overlayPhase: "loading" });
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });
});
