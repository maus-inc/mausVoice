import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const cargoManifest = read("apps/desktop/src-tauri/Cargo.toml");
const app = read("apps/desktop/src-tauri/src/app.rs");
const desktopPackage = read("apps/desktop/package.json");

describe("desktop dev-surface build contracts", () => {
  it("compiles Tauri inspection support only through debug-assist", () => {
    assert.match(cargoManifest, /debug-assist\s*=\s*\["tauri\/devtools"\]/);
    assert.match(
      cargoManifest,
      /tauri\s*=\s*\{[^\n]*features\s*=\s*\[(?![^\n]*"devtools")/,
    );
    assert.match(
      app,
      /#\[cfg\(feature = "debug-assist"\)\][\s\S]*MAUSVOICE_ENABLE_DEVTOOLS/,
    );
  });

  it("keeps local developer artifacts inspectable", () => {
    assert.match(desktopPackage, /tauri dev --features debug-assist/);
    assert.match(desktopPackage, /tauri build --debug --features debug-assist/);
  });

});
