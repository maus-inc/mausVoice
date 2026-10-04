import { commands } from "@maus-inc/desktop-native-apis";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  new URL("../src-tauri/src/app.rs", import.meta.url),
  "utf8",
);
const commandsSource = readFileSync(
  new URL("../src-tauri/src/commands.rs", import.meta.url),
  "utf8",
);

const setupStart = appSource.indexOf(".setup(|app|");
const invokeHandlerStart = appSource.indexOf(".invoke_handler(", setupStart);
const setupSource = appSource.slice(setupStart, invokeHandlerStart);

const closeHandlerStart = appSource.indexOf("WindowEvent::CloseRequested");
const closeHandlerEnd = appSource.indexOf(
  "WindowEvent::Moved",
  closeHandlerStart,
);
const closeHandlerSource = appSource.slice(closeHandlerStart, closeHandlerEnd);

describe("Windows startup elevation", () => {
  it("never starts the UAC relaunch while Tauri is still in setup", () => {
    expect(setupStart).toBeGreaterThanOrEqual(0);
    expect(invokeHandlerStart).toBeGreaterThan(setupStart);
    expect(setupSource).not.toContain("request_elevation_relaunch");
    expect(setupSource).not.toContain("request_admin_relaunch");
  });

  it("exposes quit_app as a process-exit command on the native and TS APIs", () => {
    expect(typeof commands.quitApp).toBe("function");
    expect(typeof commands.requestAdminRelaunch).toBe("function");

    expect(appSource).toContain("crate::commands::quit_app");
    expect(commandsSource).toMatch(/pub fn quit_app\([\s\S]*?app\.exit\(0\)/);
  });

  it("keeps main-window CloseRequested as hide-to-tray, not process exit", () => {
    expect(closeHandlerStart).toBeGreaterThanOrEqual(0);
    expect(closeHandlerSource).toContain("api.prevent_close()");
    expect(closeHandlerSource).toContain("hide_main_window");
    expect(closeHandlerSource).not.toContain("app.exit");
    expect(closeHandlerSource).not.toContain("quit_app");
  });
});
