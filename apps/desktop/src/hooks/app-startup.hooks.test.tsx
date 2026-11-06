// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preflight: vi.fn().mockResolvedValue(undefined),
  logging: vi.fn().mockResolvedValue(undefined),
  consume: vi.fn(),
  surface: vi.fn().mockResolvedValue(undefined),
  logger: { warning: vi.fn() },
}));
vi.mock("../actions/elevation.actions", () => ({
  runStartupElevationPreflight: mocks.preflight,
}));
vi.mock("../utils/log.utils", () => ({
  initLogging: mocks.logging,
  getLogger: () => mocks.logger,
}));
vi.mock("../utils/platform.utils", () => ({ getPlatform: () => "windows" }));
vi.mock("../utils/window.utils", () => ({
  consumeSurfaceWindowFlag: mocks.consume,
  surfaceMainWindow: mocks.surface,
}));
import { useAppStartup } from "./app-startup.hooks";

const Probe = () => {
  useAppStartup(true);
  return null;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.consume.mockReset().mockReturnValueOnce(true).mockReturnValue(false);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());
it("runs elevation once and consumes a pending surface request under Strict Mode", async () => {
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () =>
      root.render(createElement(StrictMode, null, createElement(Probe))),
    );
    expect(mocks.preflight).toHaveBeenCalledExactlyOnceWith({
      isMainWindow: true,
      platform: "windows",
    });
    expect(mocks.surface).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});
