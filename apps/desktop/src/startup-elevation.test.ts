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
const bindingsSource = readFileSync(
  new URL(
    "../../../packages/desktop-native-apis/src/bindings.ts",
    import.meta.url,
  ),
  "utf8",
);
const sideEffectsSource = readFileSync(
  new URL("./components/root/AppSideEffects.tsx", import.meta.url),
  "utf8",
);
const dialogSource = readFileSync(
  new URL("./components/root/ElevationDeclinedDialog.tsx", import.meta.url),
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

  it("registers quit_app as a process-exit command", () => {
    expect(commandsSource).toContain("pub fn quit_app");
    expect(commandsSource).toMatch(/pub fn quit_app\([\s\S]*?app\.exit\(0\)/);
    expect(appSource).toContain("crate::commands::quit_app");
    expect(bindingsSource).toContain('TAURI_INVOKE("quit_app")');
  });

  it("keeps main-window CloseRequested as hide-to-tray, not process exit", () => {
    expect(closeHandlerStart).toBeGreaterThanOrEqual(0);
    expect(closeHandlerSource).toContain("api.prevent_close()");
    expect(closeHandlerSource).toContain("hide_main_window");
    // The close handler must not call app.exit — that path is quit_app only.
    expect(closeHandlerSource).not.toContain("app.exit");
    expect(closeHandlerSource).not.toContain("quit_app");
  });

  it("requests elevation from the frontend before full app init, not after prefs hydrate alone", () => {
    // Gate flag must be consulted before auth/init work.
    expect(sideEffectsSource).toContain("elevationStartupPending");
    expect(sideEffectsSource).toContain(
      "Requesting administrator relaunch before full app startup",
    );
    // Pref is read directly from the preferences repo (minimal subset), not
    // waited on full refreshCurrentUser / auth.
    expect(sideEffectsSource).toContain(
      "getUserPreferencesRepo().getUserPreferences()",
    );
    // Must not still use the old "after frontend startup" wording / prefs-only gate.
    expect(sideEffectsSource).not.toContain(
      "Requesting administrator relaunch after frontend startup",
    );
  });

  it("closes the app via quitApp rather than window.close from the decline dialog", () => {
    expect(dialogSource).toContain("quitApp");
    expect(dialogSource).not.toContain("getCurrentWindow().close()");
    expect(dialogSource).not.toContain('from "@tauri-apps/api/window"');
  });
});
