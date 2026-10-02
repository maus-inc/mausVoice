import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

// The one job in this repository that compiles that tree.
const WINDOWS_JOB_WORKFLOW = ".github/workflows/test-desktop-unit.yml";
const WINDOWS_JOB = "rust-windows-gated";

// Every `cargo test` line in a job pinned to a Windows runner, across every
// workflow. The claim being checked is about the runner, not about the line: a
// `cargo test` in the same file under `ubuntu-latest` runs the desktop crate's
// Linux-gated tests and is wanted, so the scan has to know the job's `runs-on`.
function windowsRunnerCargoTests(workflowDir) {
  const found = [];
  for (const file of readdirSync(workflowDir).filter((f) =>
    /\.ya?ml$/.test(f),
  )) {
    const lines = read(`${workflowDir}/${file}`).split("\n");
    let job = null;
    let onWindows = false;
    for (const line of lines) {
      const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (start) {
        job = start[1];
        onWindows = false;
      }
      if (/^ {4}runs-on:/.test(line)) onWindows = /windows/.test(line);
      if (onWindows && /cargo test\b/.test(line)) {
        found.push(`${file}:${job}: ${line.trim()}`);
      }
    }
  }
  return found;
}

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

describe("Windows-gated coverage is recorded, not silent", () => {
  // The desktop crate's `cfg(windows)` unit tests are compiled by clippy on the
  // Windows runner and executed nowhere: the test binary links the whole lib,
  // which reaches `tauri` -> `wry` -> `webview2-com` -> `WebView2Loader.dll`,
  // and a GitHub `windows-2022` image ships no WebView2 runtime, so the process
  // fails to load before libtest can report anything. The four `#[cfg(test)]`
  // modules themselves need nothing but the code under test, so the gap is a
  // loader, not the tests -- which makes it worth stating here, because "no job
  // runs them" and "no job can run them" call for different responses.
  //
  // Pin all three halves. A compile step that stops covering `cfg(test)` must
  // not pass unnoticed, and a `cargo test` that is added without the record
  // being updated fails instead of quietly making the comment wrong.
  const windowsJobBody = (() => {
    const lines = read(WINDOWS_JOB_WORKFLOW).split("\n");
    const start = lines.findIndex((line) =>
      new RegExp(`^ {2}${WINDOWS_JOB}:\\s*$`).test(line),
    );
    assert.notEqual(start, -1, `${WINDOWS_JOB} must exist in the workflow`);
    let end = start + 1;
    while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end]))
      end += 1;
    return { lines, start, text: lines.slice(start, end).join("\n") };
  })();

  it("compiles the cfg(windows) test modules on a Windows runner", () => {
    assert.match(
      windowsJobBody.text,
      /cargo clippy --locked --all-targets -- -D warnings/,
      "--all-targets is what compiles the `cfg(test)` modules; --lib or --bin " +
        "would leave every Windows-gated unit test unchecked",
    );
    assert.match(
      windowsJobBody.text,
      /working-directory: apps\/desktop\/src-tauri/,
      "the lint must run against the desktop crate, not a pill crate",
    );
  });

  it("executes none of them, and says why in the workflow", () => {
    assert.doesNotMatch(
      windowsJobBody.text,
      /cargo test\b/,
      "cargo test on this runner cannot start; if the WebView2 runtime is ever " +
        "provisioned, add the step and delete the note above the job",
    );
    // The note sits above the job, where a reader of the workflow meets it.
    let above = windowsJobBody.start - 1;
    while (above >= 0 && windowsJobBody.lines[above].trim() === "") above -= 1;
    const note = [];
    while (above >= 0 && /^\s*#/.test(windowsJobBody.lines[above])) {
      note.unshift(windowsJobBody.lines[above]);
      above -= 1;
    }
    assert.match(
      note.join("\n"),
      /WebView2/,
      "the compile-only record has to live in the workflow, not in a commit message",
    );
  });

  it("has no other job running the desktop crate's Windows tests", () => {
    const elsewhere = windowsRunnerCargoTests(`${repoRoot}/.github/workflows`);
    assert.deepEqual(
      elsewhere,
      [],
      "a `cargo test` on a Windows runner is exactly the step this record says " +
        "does not exist; if it was added, the note above the job is now wrong",
    );
  });
});
