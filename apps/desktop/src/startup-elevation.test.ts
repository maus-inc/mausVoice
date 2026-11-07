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

const setupFunctionStart = appSource.indexOf("fn setup_app(");
const buildFunctionStart = appSource.indexOf(
  "pub fn build()",
  setupFunctionStart,
);
const setupRegistrationStart = appSource.indexOf(
  ".setup(setup_app)",
  buildFunctionStart,
);
const invokeHandlerStart = appSource.indexOf(
  ".invoke_handler(",
  setupRegistrationStart,
);
const setupSource = appSource.slice(setupFunctionStart, buildFunctionStart);

const closeHandlerStart = appSource.indexOf("WindowEvent::CloseRequested");
const closeHandlerEnd = appSource.indexOf(
  "WindowEvent::Moved",
  closeHandlerStart,
);
const closeHandlerSource = appSource.slice(closeHandlerStart, closeHandlerEnd);

describe("Windows startup elevation", () => {
  it("never starts the UAC relaunch while Tauri is still in setup", () => {
    expect(setupFunctionStart).toBeGreaterThanOrEqual(0);
    expect(buildFunctionStart).toBeGreaterThan(setupFunctionStart);
    expect(setupRegistrationStart).toBeGreaterThan(buildFunctionStart);
    expect(invokeHandlerStart).toBeGreaterThan(setupRegistrationStart);
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
