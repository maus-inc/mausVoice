// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, () => void | Promise<void>>(),
  interval: null as null | (() => Promise<void>),
  invoke: vi.fn().mockResolvedValue(undefined),
  check: vi.fn().mockResolvedValue(undefined),
  open: vi.fn().mockResolvedValue(undefined),
  list: vi.fn(),
  surface: vi.fn().mockResolvedValue(undefined),
  dev: false,
  logger: { error: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../actions/updater.actions", () => ({
  checkForAppUpdates: mocks.check,
  openUpdateDialog: mocks.open,
}));
vi.mock("../repos", () => ({
  getTranscriptionRepo: () => ({ listTranscriptions: mocks.list }),
}));
vi.mock("../utils/env.utils", () => ({ getIsDevMode: () => mocks.dev }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("../utils/window.utils", () => ({ surfaceMainWindow: mocks.surface }));
vi.mock("./helper.hooks", () => ({
  useIntervalAsync: (_interval: number, callback: () => Promise<void>) => {
    mocks.interval = callback;
  },
}));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (event: string, listener: () => void | Promise<void>) =>
    mocks.listeners.set(event, listener),
}));
import { useAppTrayActions } from "./app-tray-actions.hooks";

const Probe = ({ main }: { main: boolean }) => {
  useAppTrayActions(main);
  return null;
};
describe("application tray actions", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.interval = null;
    mocks.dev = false;
    mocks.list.mockResolvedValue([{ transcript: "hello" }]);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it("polls for updates and routes tray actions through their existing owners", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    await mocks.interval!();
    expect(mocks.check).toHaveBeenCalledOnce();
    await mocks.listeners.get("tray-copy-last-transcript")!();
    expect(mocks.list).toHaveBeenCalledWith({ limit: 1 });
    expect(mocks.invoke).toHaveBeenCalledWith("copy_to_clipboard", {
      text: "hello",
    });
    mocks.listeners.get("tray-install-update")!();
    expect(mocks.surface).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledOnce();
  });
  it("avoids polling in dev builds and all tray work in secondary windows", async () => {
    mocks.dev = true;
    await act(async () => root.render(createElement(Probe, { main: true })));
    await mocks.interval!();
    expect(mocks.check).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Probe, { main: false })));
    await mocks.listeners.get("tray-copy-last-transcript")!();
    mocks.listeners.get("tray-install-update")!();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.surface).not.toHaveBeenCalled();
  });
  it("observes a rejected update-dialog request", async () => {
    mocks.open.mockRejectedValueOnce(new Error("update failed"));
    await act(async () => root.render(createElement(Probe, { main: true })));
    mocks.listeners.get("tray-install-update")!();
    await vi.waitFor(() =>
      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("update failed"),
      ),
    );
  });
});
