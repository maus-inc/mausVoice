// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createIntl } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (payload: never) => void>(),
  invoke: vi.fn().mockResolvedValue(undefined),
  setLanguage: vi.fn().mockResolvedValue(undefined),
  observe: vi.fn(),
  cleanup: vi.fn(),
  labels: vi.fn().mockResolvedValue(undefined),
  menu: [{ code: "en", selected: true }],
  window: {
    onFocusChanged: vi.fn(),
    onResized: vi.fn(),
    onCloseRequested: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mocks.window,
}));
vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: { setDashboardMenuLabels: mocks.labels },
}));
vi.mock("../actions/user.actions", () => ({
  setActiveDictationLanguage: mocks.setLanguage,
}));
vi.mock("../store", () => ({
  useAppStore: (selector: (state: object) => unknown) => selector({}),
}));
vi.mock("../utils/tray-language.utils", () => ({
  buildTrayLanguageMenuModel: () => mocks.menu,
}));
vi.mock("../utils/tray-dashboard-visibility.utils", () => ({
  getLocalizedDashboardMenuLabels: () => ({
    openLabel: "Open",
    hideLabel: "Hide",
  }),
}));
vi.mock("../utils/dashboard-menu-observer", () => ({
  observeDashboardMenu: mocks.observe,
}));
vi.mock("./tauri.hooks", () => ({
  useTauriListen: (event: string, listener: (payload: never) => void) =>
    mocks.listeners.set(event, listener),
}));
import { useTrayMenuSync } from "./tray-menu-sync.hooks";

const intl = createIntl({ locale: "en" });
const Probe = ({ main, hidden }: { main: boolean; hidden: boolean }) => {
  useTrayMenuSync({ isMainWindow: main, intl, menuBarIconHidden: hidden });
  return null;
};

describe("tray menu synchronization", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.menu = [{ code: "en", selected: true }];
    mocks.observe.mockReturnValue(mocks.cleanup);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it("pushes preferences, language updates, and owns the dashboard observer", async () => {
    await act(async () =>
      root.render(createElement(Probe, { main: true, hidden: false })),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("set_tray_visible", {
      visible: true,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("set_tray_language_menu", {
      items: mocks.menu,
    });
    expect(mocks.observe).toHaveBeenCalledOnce();
    mocks.listeners.get("tray-set-dictation-language")?.("fr" as never);
    expect(mocks.setLanguage).toHaveBeenCalledWith("fr");
    mocks.menu = [{ code: "fr", selected: true }];
    await act(async () =>
      root.render(createElement(Probe, { main: true, hidden: true })),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("set_tray_visible", {
      visible: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("set_tray_language_menu", {
      items: mocks.menu,
    });
    await act(async () =>
      root.render(createElement(Probe, { main: false, hidden: true })),
    );
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
  it("does not mutate the tray from a secondary window", async () => {
    await act(async () =>
      root.render(createElement(Probe, { main: false, hidden: false })),
    );
    mocks.listeners.get("tray-set-dictation-language")?.("fr" as never);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(mocks.setLanguage).not.toHaveBeenCalled();
  });
});
