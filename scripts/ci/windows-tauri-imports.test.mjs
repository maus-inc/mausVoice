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

// The crate whose `cfg(windows)` unit tests this record is about. The scan is
// scoped to it because "no job runs them" is a claim about this crate: a Windows
// runner running the pill crates' own tests is not the step this record says
// does not exist, and `lint-desktop.yml` runs several of those under a Windows
// matrix entry. Without the scope, resolving that matrix -- which the previous
// version could not see at all -- would fail the guard on correct work.
const GATED_CRATE_MANIFEST = "apps/desktop/src-tauri";

// Every `cargo test` against that crate in a job pinned to a Windows runner,
// across every workflow. The claim being checked is about the runner, not just
// the line: a `cargo test` in the same file under `ubuntu-latest` runs the
// desktop crate's Linux-gated tests and is wanted.
function windowsRunnerCargoTests(workflowDir) {
  const found = [];
  for (const file of readdirSync(workflowDir).filter((f) =>
    /\.ya?ml$/.test(f),
  )) {
    found.push(
      ...windowsRunnerCargoTestsIn(read(`${workflowDir}/${file}`), file),
    );
  }
  return found;
}

// The same scan over one workflow's text, so a synthetic workflow can be fed
// to it. `label` names the source in each record.
function windowsRunnerCargoTestsIn(text, label) {
  const found = [];
  for (const job of jobBlocks(text)) {
    if (!runsOnWindows(job.text)) continue;
    for (const line of job.text.split("\n")) {
      if (/cargo test\b/.test(line) && line.includes(GATED_CRATE_MANIFEST)) {
        found.push(`${label}:${job.name}: ${line.trim()}`);
      }
    }
  }
  return found;
}

// The jobs of one workflow, as { name, start, lines, text } records.
//
// Two of the guards below read a job's own body, so where one job ends and the
// next begins is decided once, here. Each of the three rules below is a rule the
// two hand-rolled splitters this replaced did not agree on, and the disagreement
// was invisible because no workflow in this tree violates the difference:
//
//   * A job is a two-space key *under `jobs:`*. Scanning from the top of the
//     file instead also matches `on:`'s own two-space keys, so `push`,
//     `pull_request` and `workflow_dispatch` were read as jobs -- in all nine
//     workflows here. Harmless today only because an event block carries no
//     `runs-on:` to resolve.
//   * A body ends at the next two-space key *or at the next top-level key*. A
//     top-level `env:` or `defaults:` after `jobs:` is legal, and GitHub's own
//     documentation puts `env:` at the top level; one splitter stopped there and
//     the other swallowed it into the last job's body.
//   * `start` and `lines` are carried so a caller can read what sits around a
//     job, which the note above `rust-windows-gated` needs.
function jobBlocks(workflowText) {
  const lines = workflowText.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return [];
  const jobs = [];
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const opened = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (!opened) continue;
    let end = index + 1;
    while (
      end < lines.length &&
      !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end]) &&
      !/^\S/.test(lines[end])
    ) {
      end += 1;
    }
    jobs.push({
      name: opened[1],
      start: index,
      lines: lines.slice(index, end),
      text: lines.slice(index, end).join("\n"),
    });
    index = end - 1;
  }
  return jobs;
}

// Whether a job body can run on a Windows runner.
//
// `runs-on: ${{ matrix.os }}` was invisible to the previous version, so a
// `cargo test` added under one of these jobs would not have been found and the
// guard would have kept passing. A matrix value is therefore resolved against
// the job's own `strategy.matrix`, through both spellings a workflow can use:
// the `include:` list of whole entries and a bare `key: [a, b]` list.
//
// An expression that cannot be resolved from the job body -- one fed by a
// `needs` output, say -- reads as "not Windows", because guessing would invent
// a run that may not exist. `unresolvedRunnerExpressions` counts them so a test
// can assert the resolver is not simply blind, and so a job that changes shape
// is visible rather than silent.
const unresolvedRunnerExpressions = [];
function runsOnWindows(jobText) {
  const runsOn = /^ {4}runs-on:\s*(.+)$/m.exec(jobText);
  if (!runsOn) return false;
  const value = runsOn[1].trim();
  if (!/windows/i.test(value)) {
    // The only expression this resolves is a matrix reference; anything else in
    // `${{ }}` is fed from somewhere the job body does not carry.
    const matrix = /\bmatrix\.([A-Za-z0-9_-]+)/.exec(value);
    if (!matrix || !/\$\{\{/.test(value)) {
      if (/\$\{\{/.test(value)) unresolvedRunnerExpressions.push(value);
      return false;
    }
    const values = matrixValues(jobText, matrix[1]);
    if (values === null) {
      unresolvedRunnerExpressions.push(value);
      return false;
    }
    return values.some((entry) => /windows/i.test(entry));
  }
  return true;
}

// Every value `matrix.<key>` can take in this job, from an `include:` entry list
// or a bare list. Null when the key appears in neither.
function matrixValues(jobText, key) {
  const lines = jobText.split("\n");
  const matrixAt = lines.findIndex((line) => /^ {6}matrix:\s*$/.test(line));
  if (matrixAt === -1) return null;
  // One rule for both spellings, because they are the same fact written twice:
  // `include:` entries carry `- label: Windows` then `  os: windows-latest` at a
  // deeper indent, and a bare list is `os: [ubuntu-22.04, windows-latest]`. Only
  // the trailing value is wanted, and only from inside the matrix block -- a
  // `key:` elsewhere in the job is not what `matrix.key` resolves to.
  const values = [];
  const depth = 6; // the indent of the `matrix:` key this block sits under
  for (let index = matrixAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = /^ */.exec(line)[0].length;
    if (indent <= depth) break;
    if (line.trim() === "") continue;
    const assignment = new RegExp(`^ *-? *${key}: *(.*)$`).exec(line);
    if (!assignment) continue;
    for (const part of assignment[1].split(",")) {
      const value = part
        .trim()
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .replace(/^["']|["']$/g, "");
      if (value) values.push(value);
    }
  }
  return values.length > 0 ? values : null;
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
    const job = jobBlocks(lines.join("\n")).find(
      (entry) => entry.name === WINDOWS_JOB,
    );
    assert.ok(job, `${WINDOWS_JOB} must exist in the workflow`);
    return { lines, start: job.start, text: job.text };
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

  // The scan used to read a job's runner off its own `runs-on:` line and nothing
  // else, so `runs-on: ${{ matrix.os }}` was invisible: `lint-desktop.yml` and
  // `test-package-rust-transcription.yml` both use it, and both carry a
  // `windows-latest` matrix entry. A `cargo test` added under such a job would
  // have gone unnoticed while this guard kept passing, which is the one way a
  // record like this rots -- silently, in the direction that reassures.
  it("sees a Windows runner that arrives through a matrix", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - label: Linux",
      "            os: ubuntu-22.04",
      "          - label: Windows",
      "            os: windows-latest",
      "    steps:",
      "      - run: cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib",
      "",
    ].join("\n");
    assert.deepEqual(
      windowsRunnerCargoTestsIn(workflow, "synthetic.yml"),
      [
        // The whole step line, `- run:` and all: this record is read by a
        // person deciding whether the note above the job is still true, and a
        // rewritten line would not match what they see in the workflow.
        "synthetic.yml:build: - run: cargo test --locked --manifest-path " +
          "apps/desktop/src-tauri/Cargo.toml --lib",
      ],
      "a Windows runner expressed as a matrix value is still a Windows runner",
    );
  });

  it("resolves a matrix given as a bare list", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      matrix:",
      "        os: [ubuntu-22.04, windows-latest]",
      "    steps:",
      "      - run: cargo test --locked --working-directory: apps/desktop/src-tauri",
      "",
    ].join("\n");
    assert.equal(
      windowsRunnerCargoTestsIn(workflow, "synthetic.yml").length,
      1,
    );
  });

  it("calls a matrix with no Windows entry a non-Windows job", () => {
    const workflow = [
      "jobs:",
      "  build:",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - os: ubuntu-22.04",
      "          - os: macos-14",
      "    steps:",
      "      - run: cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml",
      "",
    ].join("\n");
    assert.deepEqual(
      windowsRunnerCargoTestsIn(workflow, "synthetic.yml"),
      [],
      "a matrix with no Windows runner runs nothing on Windows",
    );
  });

  it("ignores a Windows job that tests a crate this record is not about", () => {
    // `lint-desktop.yml` runs the pill crates' tests under its Windows matrix
    // entry. Those are wanted, and the scan has to be scoped to the desktop
    // crate for the guard to be able to resolve that matrix at all -- otherwise
    // fixing the blindness would fail the guard on correct work.
    const workflow = [
      "jobs:",
      "  lint:",
      "    runs-on: ${{ matrix.os }}",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - os: windows-latest",
      "    steps:",
      "      - run: cargo test --locked --manifest-path packages/rust_windows_pill/Cargo.toml",
      "",
    ].join("\n");
    assert.deepEqual(
      windowsRunnerCargoTestsIn(workflow, "synthetic.yml"),
      [],
      "the pill crates' Windows tests are not the step this record says is absent",
    );
  });

  it("records a runner expression it cannot resolve instead of guessing", () => {
    const before = unresolvedRunnerExpressions.length;
    const workflow = [
      "jobs:",
      "  build:",
      "    runs-on: ${{ needs.setup.outputs.os }}",
      "    steps:",
      "      - run: cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml",
      "",
    ].join("\n");
    assert.deepEqual(windowsRunnerCargoTestsIn(workflow, "synthetic.yml"), []);
    assert.ok(
      unresolvedRunnerExpressions.length > before,
      "a runner fed by a `needs` output must be visible to a reader, not silently " +
        "counted as a non-Windows job",
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

// The two guards above read a job body through one splitter between them, and
// these are the rules it has to hold. Each one is a rule the two hand-rolled
// splitters disagreed about, and neither disagreement was visible in this
// repository: every workflow here triggers on `push` and none carries a
// top-level key after `jobs:`, so both wrong answers were the right answer for
// every file in the tree. That is the shape of a bug that ships.
describe("the job splitter both guards share", () => {
  it("does not read a trigger's own keys as jobs", () => {
    // `on:`'s children are two-space keys too. Reading from the top of the file
    // rather than from `jobs:` collects `push`, `pull_request` and
    // `workflow_dispatch` as jobs -- which is what it did for all nine
    // workflows here, and only stayed harmless because an event block has no
    // `runs-on:` for the resolver to misread.
    const workflow = [
      "on:",
      "  push:",
      "    paths:",
      "      - scripts/ci/anything.test.mjs",
      "  workflow_dispatch:",
      "permissions: {}",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "",
    ].join("\n");
    assert.deepEqual(
      jobBlocks(workflow).map((job) => job.name),
      ["build"],
      "only a key under `jobs:` is a job",
    );
  });

  it("ends a job at a top-level key that follows jobs:", () => {
    // A top-level `env:` after `jobs:` is legal, and GitHub documents `env:` as
    // a top-level key. Swallowing it into the last job's body puts text in a job
    // block that the job never declared, which is the direction that reassures:
    // a `cargo test` or a `runs-on:` in a top-level block would be read as
    // belonging to the job above it.
    const workflow = [
      "permissions: {}",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "env:",
      "  NOT_A_JOB_STEP: true",
      "",
    ].join("\n");
    const jobs = jobBlocks(workflow);
    assert.deepEqual(
      jobs.map((job) => job.name),
      ["build"],
    );
    assert.doesNotMatch(
      jobs[0].text,
      /NOT_A_JOB_STEP/,
      "a top-level key after `jobs:` is not part of the last job's body",
    );
  });

  it("keeps the line a job starts on, so a caller can read what sits above it", () => {
    // `windowsJobBody` reads the comment above `rust-windows-gated` by walking up
    // from the job's first line, so `start` has to be the index in the whole
    // file rather than an offset into the jobs section.
    const workflow = [
      "permissions: {}",
      "jobs:",
      "  first:",
      "    runs-on: ubuntu-latest",
      "  second:",
      "    runs-on: windows-2022",
      "",
    ].join("\n");
    assert.deepEqual(
      jobBlocks(workflow).map((job) => job.start),
      [2, 4],
    );
    assert.equal(jobBlocks(workflow)[0].lines[0], "  first:");
  });
});
