// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logger: { warning: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import { useNativeCapabilities } from "./native-capabilities.hooks";

const Probe = () => {
  useNativeCapabilities();
  return null;
};
beforeEach(() => {
  vi.clearAllMocks();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  vi.unstubAllGlobals();
});

it("commits the complete set of native capabilities", async () => {
  mocks.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "get_hotkey_strategy"
        ? "listener"
        : command === "supports_paste_keybinds"
          ? "per-app"
          : true,
    ),
  );
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(createElement(Probe)));
    await vi.waitFor(() =>
      expect(getAppState().hotkeyStrategy).toBe("listener"),
    );
    expect(getAppState().supportsAppDetection).toBe(true);
    expect(getAppState().supportsPasteKeybinds).toBe("per-app");
  } finally {
    await act(async () => root.unmount());
  }
});

it("discards a late probe result after unmount", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  mocks.invoke.mockReturnValue(pending);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => root.unmount());
  await act(async () => {
    resolve("listener");
    await pending;
  });
  expect(getAppState().hotkeyStrategy).toBe(INITIAL_APP_STATE.hotkeyStrategy);
  expect(getAppState().supportsAppDetection).toBe(
    INITIAL_APP_STATE.supportsAppDetection,
  );
});
