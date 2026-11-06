// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  invoke: vi.fn().mockResolvedValue(undefined),
  toggle: vi.fn().mockResolvedValue({ previous: "persistent", next: "hidden" }),
  ensureGeometry: vi.fn().mockResolvedValue(undefined),
  setGeometry: vi.fn(),
  getPrefs: vi.fn(() => ({ pillResetMonitorStrategy: "primary" })),
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../actions/user.actions", () => ({
  toggleDictationPillVisibility: mocks.toggle,
}));
vi.mock("../store", () => ({ getAppState: () => ({}) }));
vi.mock("../utils/composer.utils", () => ({
  ensurePillGeometry: mocks.ensureGeometry,
  setPillGeometry: mocks.setGeometry,
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("../utils/user.utils", async (original) => ({
  ...(await original<typeof import("../utils/user.utils")>()),
  getMyUserPreferences: mocks.getPrefs,
}));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (event: string, listener: (payload: never) => void) =>
    mocks.listeners.set(event, listener),
}));
import { useTrayPillControls } from "./tray-pill-controls.hooks";

const intl = createIntl({ locale: "en" });
intl.formatMessage = ((message: { defaultMessage?: string }) =>
  message.defaultMessage ?? "") as typeof intl.formatMessage;
const Probe = ({ main, visibility }: { main: boolean; visibility: string }) => {
  useTrayPillControls({ isMainWindow: main, intl, visibility });
  return null;
};

describe("tray pill controls", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps labels synced to committed settings and dispatches each toggle", async () => {
    await act(async () =>
      root.render(
        createElement(Probe, { main: true, visibility: "persistent" }),
      ),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_pill_visibility_menu_state",
      { label: "Hide Pill" },
    );
    expect(mocks.ensureGeometry).toHaveBeenCalledOnce();
    await act(async () => {
      mocks.listeners.get("tray-toggle-pill-visibility")?.(undefined as never);
    });
    expect(mocks.toggle).toHaveBeenCalledOnce();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("persistent -> hidden"),
    );
    await act(async () =>
      root.render(createElement(Probe, { main: true, visibility: "hidden" })),
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_pill_visibility_menu_state",
      { label: "Show Pill" },
    );
  });

  it("uses current reset settings and forwards saved geometry", async () => {
    await act(async () =>
      root.render(createElement(Probe, { main: true, visibility: "hidden" })),
    );
    mocks.listeners.get("tray-reset-pill-position")?.(undefined as never);
    expect(mocks.invoke).toHaveBeenCalledWith("reset_pill_position", {
      strategy: "primary",
    });
    const event = {
      hasSavedPosition: true,
      rect: { x: 1, y: 2, width: 3, height: 4 },
    };
    mocks.listeners.get("pill-position-changed")?.(event as never);
    expect(mocks.setGeometry).toHaveBeenCalledWith(event.rect, null);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_reset_pill_position_enabled",
      { enabled: true },
    );
  });

  it("does not act from a secondary window", async () => {
    await act(async () =>
      root.render(
        createElement(Probe, { main: false, visibility: "persistent" }),
      ),
    );
    for (const event of [
      "tray-toggle-pill-visibility",
      "tray-reset-pill-position",
      "pill-position-changed",
    ]) {
      mocks.listeners.get(event)?.(undefined as never);
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.toggle).not.toHaveBeenCalled();
    expect(mocks.ensureGeometry).not.toHaveBeenCalled();
    expect(mocks.setGeometry).not.toHaveBeenCalled();
  });
});
