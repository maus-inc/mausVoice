import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import {
  CARGO_FEATURE,
  DEVTOOLS_ENV_VAR,
  TAURI_DEVTOOLS_FEATURE,
} from "./dev-surface-config.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

const cargoManifest = parseToml(
  read("apps/desktop/src-tauri/Cargo.toml"),
);
const app = read("apps/desktop/src-tauri/src/app.rs");
const desktopPackage = JSON.parse(read("apps/desktop/package.json"));

describe("desktop dev-surface build contracts", () => {
  it("compiles Tauri inspection support only through debug-assist", () => {
    // The Cargo feature must exist and map to exactly the Tauri devtools flag.
    const features = cargoManifest.features;
    assert.ok(features, "Cargo.toml is missing a [features] table");
    assert.deepStrictEqual(
      features[CARGO_FEATURE],
      [TAURI_DEVTOOLS_FEATURE],
      `Expected features.${CARGO_FEATURE} to equal [${JSON.stringify(TAURI_DEVTOOLS_FEATURE)}]`,
    );

    // The base `tauri` dependency must NOT bake devtools in unconditionally —
    // it should only come through the opt-in feature above.
    const tauriDep = cargoManifest.dependencies?.tauri;
    assert.ok(tauriDep, "tauri dependency is missing from Cargo.toml");
    const tauriFeatures =
      typeof tauriDep === "string" ? [] : tauriDep.features ?? [];
    assert.ok(
      !tauriFeatures.includes("devtools"),
      `tauri dependency must not list "devtools" in its features (found: ${JSON.stringify(tauriFeatures)})`,
    );

    // The Rust source must gate devtools behind BOTH the compile-time feature
    // and the runtime env-var — with the cfg attribute directly on the `if`.
    const cfgGate = new RegExp(
      `#\\[cfg\\(feature = "${CARGO_FEATURE}"\\)\\]\\s*if\\s+std::env::var\\(\\s*"${DEVTOOLS_ENV_VAR}"\\s*\\)`,
    );
    assert.match(
      app,
      cfgGate,
      `app.rs must pair #[cfg(feature = "${CARGO_FEATURE}")] directly with the if std::env::var("${DEVTOOLS_ENV_VAR}") check`,
    );
  });

  it("keeps local developer artifacts inspectable", () => {
    // pnpm dev and build:mac:debug must both pass --features <CARGO_FEATURE>.
    const scripts = desktopPackage.scripts ?? {};
    const devScript = scripts["dev:tauri"] ?? "";
    const buildScript = scripts["build:mac:debug"] ?? "";

    assert.ok(
      devScript.includes(`--features ${CARGO_FEATURE}`),
      `dev:tauri script must pass --features ${CARGO_FEATURE} (got: ${devScript})`,
    );
    assert.ok(
      buildScript.includes(`--features ${CARGO_FEATURE}`),
      `build:mac:debug script must pass --features ${CARGO_FEATURE} (got: ${buildScript})`,
    );
  });
});
