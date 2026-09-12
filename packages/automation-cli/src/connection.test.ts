import { describe, expect, it } from "vitest";
import {
  AUTOMATION_DEFAULT_PORT,
  connectionFilePath,
  resolveConnection,
} from "./connection";

describe("connectionFilePath", () => {
  it("resolves per-platform config locations", () => {
    expect(
      connectionFilePath({ platform: "linux", env: {}, homeDir: "/home/u" }),
    ).toBe("/home/u/.config/com.mausinc.desktop/automation-api.json");
    expect(
      connectionFilePath({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/xdg" },
        homeDir: "/home/u",
      }),
    ).toBe("/xdg/com.mausinc.desktop/automation-api.json");
    expect(
      connectionFilePath({ platform: "darwin", env: {}, homeDir: "/Users/u" }),
    ).toBe(
      "/Users/u/Library/Application Support/com.mausinc.desktop/automation-api.json",
    );
    expect(
      connectionFilePath({
        platform: "win32",
        env: { APPDATA: "C:\\A" },
        homeDir: "C:\\U",
      }),
    ).toBe("C:\\A\\com.mausinc.desktop\\automation-api.json");
  });
});

describe("resolveConnection", () => {
  it("prefers the explicit token and port", () => {
    const conn = resolveConnection({
      token: "t",
      port: 1234,
      env: {},
      homeDir: "/home/u",
    });
    expect(conn).toEqual({ baseUrl: "http://127.0.0.1:1234", token: "t" });
  });

  it("reads the token from the environment", () => {
    const conn = resolveConnection({
      env: { MAUSVOICE_AUTOMATION_TOKEN: "env-token" },
      homeDir: "/home/u",
    });
    expect(conn.token).toBe("env-token");
    expect(conn.baseUrl).toBe(`http://127.0.0.1:${AUTOMATION_DEFAULT_PORT}`);
  });

  it("throws a helpful error when no token is available", () => {
    expect(() =>
      resolveConnection({
        platform: "linux",
        env: {},
        homeDir: "/nonexistent-dir-xyz",
      }),
    ).toThrow(/start the mausVoice desktop app/);
  });
});
