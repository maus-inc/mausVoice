import { afterEach, describe, expect, it, vi } from "vitest";

const { detectMock, tauriPlatformMock } = vi.hoisted(() => ({
  detectMock: vi.fn(() => "win32"),
  tauriPlatformMock: vi.fn(() => "macos"),
}));
vi.mock("@maus-inc/desktop-utils", () => ({
  detectDesktopPlatform: detectMock,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: tauriPlatformMock }));

import { getDesktopPlatform, isWindows } from "./env.utils";
import { getPlatform } from "./platform.utils";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("desktop and Tauri platform detection", () => {
  it("keeps desktop values separate from Tauri plugin values", () => {
    vi.stubEnv("MAUSVOICE_DESKTOP_PLATFORM", "");
    expect(getDesktopPlatform()).toBe("win32");
    expect(isWindows()).toBe(true);
    expect(getPlatform()).toBe("macos");
    expect(detectMock).toHaveBeenCalled();
    expect(tauriPlatformMock).toHaveBeenCalled();
  });

  it("uses the desktop override without consulting the detector", () => {
    vi.stubEnv("MAUSVOICE_DESKTOP_PLATFORM", "darwin");
    expect(getDesktopPlatform()).toBe("darwin");
    expect(detectMock).not.toHaveBeenCalled();
  });
});
