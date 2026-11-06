// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  label: "main",
  intl: {},
  runtime: vi.fn(),
  bootstrap: vi.fn(),
  analytics: vi.fn(),
  chrome: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: mocks.label }),
}));
vi.mock("react-intl", () => ({ useIntl: () => mocks.intl }));
vi.mock("../../hooks/app-runtime-effects.hooks", () => ({
  useAppRuntimeEffects: mocks.runtime,
}));
vi.mock("../../hooks/app-auth-bootstrap.hooks", () => ({
  useAppAuthBootstrap: mocks.bootstrap,
}));
vi.mock("../../hooks/app-analytics.hooks", () => ({
  useAppAnalytics: mocks.analytics,
}));
vi.mock("../../hooks/app-chrome.hooks", () => ({ useAppChrome: mocks.chrome }));
import { AppSideEffects } from "./AppSideEffects";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => vi.unstubAllGlobals());
it("mounts all owners with the correct main-window scope", async () => {
  const root = createRoot(document.createElement("div"));
  try {
    mocks.label = "main";
    await act(async () => root.render(createElement(AppSideEffects)));
    expect(mocks.runtime).toHaveBeenLastCalledWith({
      isMainWindow: true,
      intl: mocks.intl,
    });
    expect(mocks.bootstrap).toHaveBeenLastCalledWith(true);
    expect(mocks.analytics).toHaveBeenCalledOnce();
    expect(mocks.chrome).toHaveBeenLastCalledWith({
      isMainWindow: true,
      intl: mocks.intl,
    });
    mocks.label = "composer";
    await act(async () => root.render(createElement(AppSideEffects)));
    expect(mocks.runtime).toHaveBeenLastCalledWith({
      isMainWindow: false,
      intl: mocks.intl,
    });
    expect(mocks.bootstrap).toHaveBeenLastCalledWith(false);
    expect(mocks.chrome).toHaveBeenLastCalledWith({
      isMainWindow: false,
      intl: mocks.intl,
    });
  } finally {
    await act(async () => root.unmount());
  }
});
