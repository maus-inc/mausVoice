import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// `apps/desktop/src-tauri/src/platform/windows/**` is `cfg(windows)` and is
// never compiled by the Linux, macOS or Windows-lint jobs that run here, so a
// name it calls without importing it is invisible until a Windows build. These
// two files are the only ones in that tree whose imports changed when the
// placement arithmetic was shared, so check them explicitly.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(repoRoot, p), "utf8");

const MODULES = ["apps/desktop/src-tauri/src/platform/windows/position.rs"];

describe("windows-only Rust modules import what they call", () => {
  for (const module of MODULES) {
    it(`${module} has no undeclared path`, () => {
      const source = read(module);
      const imports = [...source.matchAll(/use\s+[\w:]*\{?([^};]*)\}?;/g)]
        .flatMap((m) => m[1].split(","))
        .map((part) => part.split("::").pop()?.trim())
        .filter(Boolean);
      const localImports = [...source.matchAll(/^use\s+([\w:]+)\s*;/gm)]
        .flatMap((m) => m[1].split("::"))
        .filter(Boolean);
      const available = new Set([...imports, ...localImports]);
      const body = source
        .replace(/^use\s+[^;]+;$/gm, "")
        .replace(/\/\/.*$/gm, "");
      const called = new Set(
        [
          ...body.matchAll(
            /\b(Rect|anchor_rect|anchored_bounds)::?[a-zA-Z_]*\b/g,
          ),
        ].map((m) => m[0]),
      );
      for (const name of called) {
        if (name.endsWith("::")) continue;
        const symbol = name.split("::")[0];
        assert.ok(
          available.has(symbol),
          `${module} uses ${symbol} without importing it`,
        );
      }
      // And nothing imported is dead, which is what `-D warnings` turns fatal.
      for (const symbol of ["anchored_bounds", "anchor_rect", "Rect"]) {
        const used = new RegExp(`\\b${symbol}\\b`).test(body);
        if (imports.includes(symbol) || localImports.includes(symbol)) {
          assert.ok(used, `${module} imports ${symbol} but never uses it`);
        }
      }
    });
  }
});
