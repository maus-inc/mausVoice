import { describe, expect, it } from "vitest";
import { resolveDesktopDevScript } from "./platform-dev-config.mjs";

describe("resolveDesktopDevScript", () => {
  it("maps darwin to dev:mac", () => {
    expect(resolveDesktopDevScript("darwin")).toEqual({
      resolvedPlatform: "darwin",
      selectedScript: "dev:mac",
    });
  });

  it("maps linux to dev:linux", () => {
    expect(resolveDesktopDevScript("linux")).toEqual({
      resolvedPlatform: "linux",
      selectedScript: "dev:linux",
    });
  });

  it("maps win32 to dev:windows", () => {
    expect(resolveDesktopDevScript("win32")).toEqual({
      resolvedPlatform: "win32",
      selectedScript: "dev:windows",
    });
  });

  it("falls back to process.platform when override is empty", () => {
    const result = resolveDesktopDevScript("");
    expect(result).not.toBeNull();
    expect(result.selectedScript).toMatch(/^dev:/);
  });

  it("returns null for an unsupported platform", () => {
    expect(resolveDesktopDevScript("beos")).toBeNull();
    expect(resolveDesktopDevScript("haiku")).toBeNull();
  });
});
