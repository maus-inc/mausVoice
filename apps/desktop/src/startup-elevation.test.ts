import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(
  new URL("../src-tauri/src/app.rs", import.meta.url),
  "utf8",
);

const setupStart = appSource.indexOf(".setup(|app|");
const invokeHandlerStart = appSource.indexOf(".invoke_handler(", setupStart);
const setupSource = appSource.slice(setupStart, invokeHandlerStart);

describe("Windows startup elevation", () => {
  it("never starts the UAC relaunch while Tauri is still in setup", () => {
    expect(setupStart).toBeGreaterThanOrEqual(0);
    expect(invokeHandlerStart).toBeGreaterThan(setupStart);
    expect(setupSource).not.toContain("request_elevation_relaunch");
    expect(setupSource).not.toContain("request_admin_relaunch");
  });
});
