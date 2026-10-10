import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "run-tauri-with-sidecars.mjs"),
  "utf8",
);

describe("run-tauri-with-sidecars", () => {
  it("runs the Tauri CLI directly instead of interpreting its arguments in a shell", () => {
    // Tauri arguments originate at the package script/CLI boundary. A shell
    // would reinterpret metacharacters embedded in an otherwise ordinary
    // argument, so keep the resolved JavaScript entry point behind Node and
    // assert the wrapper keeps `spawnSync` out of shell mode.
    assert.match(source, /require\.resolve\("@tauri-apps\/cli\/tauri\.js"\)/);
    assert.match(
      source,
      /run\(process\.execPath, \[tauriCli, \.\.\.tauriArgs\]/,
    );
    assert.match(source, /shell:\s*false/);
    assert.doesNotMatch(source, /shell:\s*true/);
  });
});
