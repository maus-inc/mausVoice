// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  handler: null as null | ((payload: { action: string }) => void),
  surface: vi.fn().mockResolvedValue(undefined),
  navigate: vi.fn().mockResolvedValue(undefined),
  logger: { warning: vi.fn() },
}));
vi.mock("../router", () => ({
  getBrowserRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../utils/window.utils", () => ({ surfaceMainWindow: mocks.surface }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("./toast.hooks", () => ({
  useToastAction: (handler: typeof mocks.handler) => {
    mocks.handler = handler;
  },
}));
import { useAppToastNavigation } from "./app-toast-navigation.hooks";

const Probe = () => {
  useAppToastNavigation();
  return null;
};
describe("toast navigation", () => {
  let root: Root;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.handler = null;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });
  it("opens agent settings immediately while surfacing the main window", () => {
    mocks.handler!({ action: "open_agent_settings" });
    expect(mocks.surface).toHaveBeenCalledOnce();
    expect(getAppState().settings.agentModeDialogOpen).toBe(true);
  });
  it("surfaces and navigates to transcriptions, handling rejected navigation", async () => {
    mocks.navigate.mockRejectedValueOnce(new Error("route failed"));
    mocks.handler!({ action: "open_transcriptions" });
    await vi.waitFor(() =>
      expect(mocks.logger.warning).toHaveBeenCalledWith(
        expect.stringContaining("route failed"),
      ),
    );
    expect(mocks.surface).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenCalledWith("/dashboard/transcriptions");
  });
  it("surfaces the window without navigating", () => {
    mocks.handler!({ action: "surface_window" });
    expect(mocks.surface).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
