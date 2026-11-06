// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  placement: vi.fn().mockResolvedValue(undefined),
  windows: true,
  user: { playInteractionChime: true, interactionFeedbackVolume: 0.35 },
  prefs: { pillPlacement: "bottom" },
  logger: { warning: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../actions/windows-sync.actions", () => ({
  pushPillPlacementToNative: mocks.placement,
}));
vi.mock("../store", () => ({
  useAppStore: (selector: (state: object) => unknown) => selector({}),
}));
vi.mock("../utils/env.utils", () => ({ isWindows: () => mocks.windows }));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("../utils/user.utils", () => ({
  getMyUser: () => mocks.user,
  getMyUserPreferences: () => mocks.prefs,
}));
import { useNativeFeedbackSync } from "./native-feedback-sync.hooks";

const Probe = ({ main }: { main: boolean }) => {
  useNativeFeedbackSync(main);
  return null;
};

describe("native feedback synchronization", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windows = true;
    mocks.user = {
      playInteractionChime: true,
      interactionFeedbackVolume: 0.35,
    };
    mocks.prefs = { pillPlacement: "bottom" };
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it("mirrors the main window's persisted values at startup and on changes", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    expect(mocks.invoke).toHaveBeenCalledWith("set_interaction_chime_enabled", {
      enabled: true,
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_interaction_feedback_volume",
      { volume: 0.35 },
    );
    expect(mocks.placement).toHaveBeenCalledWith("bottom");
    mocks.user = {
      playInteractionChime: false,
      interactionFeedbackVolume: 0.5,
    };
    mocks.prefs = { pillPlacement: "top" };
    await act(async () => root.render(createElement(Probe, { main: true })));
    expect(mocks.invoke).toHaveBeenCalledWith("set_interaction_chime_enabled", {
      enabled: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_interaction_feedback_volume",
      { volume: 0.5 },
    );
    expect(mocks.placement).toHaveBeenCalledWith("top");
  });
  it("does not let a secondary window overwrite process-global native values", async () => {
    await act(async () => root.render(createElement(Probe, { main: false })));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.placement).not.toHaveBeenCalled();
  });
  it("does not push Windows placement on other platforms", async () => {
    mocks.windows = false;
    await act(async () => root.render(createElement(Probe, { main: true })));
    expect(mocks.placement).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
});
