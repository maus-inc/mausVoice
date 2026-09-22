import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = readFileSync(
  join(REPO_ROOT, "scripts", "check-bindings.sh"),
  "utf8",
);
const WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "test-desktop-unit.yml"),
  "utf8",
);

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stepOf(workflow, name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `workflow step ${name} must exist`);
  const next = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

describe("check-bindings.sh tracked-file guard", () => {
  let sandbox;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "check-bindings-"));
    git(["init", "-q"], sandbox);
    git(["config", "user.email", "test@example.com"], sandbox);
    git(["config", "user.name", "Test"], sandbox);
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("uses the valid git ls-files flag so a tracked file is accepted", () => {
    // Regression: `--error-unmatched` is not a git flag; git exits 129, the
    // guard's `!` inverts it, and check-bindings.sh wrongly reports a tracked
    // file as untracked (CI failure "bindings.ts is not tracked by git").
    writeFileSync(join(sandbox, "bindings.ts"), "export {};\n");
    git(["add", "bindings.ts"], sandbox);

    // The exact invocation the script makes; must succeed.
    assert.doesNotThrow(() =>
      git(["ls-files", "--error-unmatch", "bindings.ts"], sandbox),
    );

    // Guard against renaming the flag back to the broken typo.
    const guardLine = SCRIPT.split("\n").find((line) =>
      line.includes("git ls-files --error-unmatch"),
    );
    assert.ok(
      guardLine,
      "check-bindings.sh must guard the tracked-file check with --error-unmatch",
    );
    assert.ok(
      !SCRIPT.includes("--error-unmatched"),
      "check-bindings.sh must not use the invalid --error-unmatched flag",
    );
  });

  it("rejects an untracked file so local work is never overwritten", () => {
    writeFileSync(join(sandbox, "untracked.ts"), "export {};\n");
    assert.throws(() =>
      git(["ls-files", "--error-unmatch", "untracked.ts"], sandbox),
    );
  });

  it("runs the generator with externalBin disabled like the Rust tests", () => {
    // Regression: binding regeneration invokes tauri's build script, which
    // fails in CI with "resource path binaries/rust-transcription-cpu-*"
    // unless TAURI_CONFIG drops externalBin (the same env the cargo test
    // step needs). The verify step must declare it too.
    const verify = stepOf(WORKFLOW, "Verify generated bindings are in sync");
    assert.match(
      verify,
      /TAURI_CONFIG:\s*'?{"bundle":{"externalBin":\[\]}}'?/,
      "Verify generated bindings must set TAURI_CONFIG externalBin: []",
    );
  });

  it("declares the checked scripts in the workflow trigger paths", () => {
    // Regression: check-bindings.sh was missing from the path filter, so
    // edits to the guard or generator never re-ran the workflow.
    assert.match(
      WORKFLOW,
      /\n\s{6}- "scripts\/check-bindings\.sh"\n/,
      "workflow must trigger on scripts/check-bindings.sh",
    );
    assert.match(
      WORKFLOW,
      /\n\s{6}- "scripts\/bindings\.sh"\n/,
      "workflow must trigger on scripts/bindings.sh",
    );
    assert.match(
      WORKFLOW,
      /\n\s{6}- "scripts\/ci\/check-bindings-guard\.test\.mjs"\n/,
      "workflow must trigger on the guard test",
    );
  });
});
