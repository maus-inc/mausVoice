import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// `apps/desktop/src-tauri/src/platform/windows/**` is `cfg(windows)` and is
// never compiled by the Linux, macOS or Windows-lint jobs that run here, so a
// name it calls without importing it is invisible until a Windows build.
// `position.rs` is the module that lost its own copy of the placement helpers to
// the shared `platform::common` ones, so it is the one whose imports this guard
// reads; the other files in that tree never imported them.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(resolve(repoRoot, p), "utf8");

const MODULES = ["apps/desktop/src-tauri/src/platform/windows/position.rs"];

// The shared placement helpers and the rectangle type, in every shape a call
// site can take them: `Rect::visible_area_of(...)` and the bare
// `anchor_rect(...)` and `anchored_bounds(...)` the module actually calls.
// The `::` is optional on purpose. Written as `::?` it would require the colon
// and match only the qualified form, so unimporting either bare helper left the
// guard green.
const CALLED = /\b(Rect|anchor_rect|anchored_bounds)(?:::)?[a-zA-Z_]*\b/g;

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
      const called = new Set([...body.matchAll(CALLED)].map((m) => m[0]));
      for (const name of called) {
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

  // The guard is only as good as its view of the module, and a call site the
  // regex cannot see is one it cannot check. Pin that the view covers every
  // shape the module uses today: the qualified type call and the two bare
  // helper calls.
  it("sees the qualified and the bare call sites it has to check", () => {
    const body = read(MODULES[0])
      .replace(/^use\s+[^;]+;$/gm, "")
      .replace(/\/\/.*$/gm, "");
    const seen = new Set(
      [...body.matchAll(CALLED)].map((m) => m[0].split("::")[0]),
    );
    assert.deepEqual(
      [...seen].sort(),
      ["Rect", "anchor_rect", "anchored_bounds"],
      "a call shape the regex cannot match is a call shape the guard cannot check",
    );
  });
});
