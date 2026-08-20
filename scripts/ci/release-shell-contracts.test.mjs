import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

// POSIX-only shell tokens that pwsh (the default `run:` shell on
// windows-latest) cannot parse. Kept conservative: only patterns that are
// definitively invalid in PowerShell.
const POSIX_ONLY = [/\bif\s*\[/, /\belif\b/, /\bfi\b/, /\bthen\b/];

// Extract the steps of a workflow file as { name, shell, run } records. The
// release workflow pins structure by convention (steps are `- name:` entries
// with an optional `shell:` and a `run: |` block), so a line scanner is
// enough and keeps this test dependency-free.
const extractSteps = (workflowText) => {
  const lines = workflowText.split("\n");
  /** @type {{ name: string, shell: string | null, run: string[] }[]} */
  const steps = [];
  let current = null;
  let inRun = false;
  let runIndent = 0;

  for (const line of lines) {
    const stepMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (stepMatch) {
      if (current) steps.push(current);
      current = { name: stepMatch[1], shell: null, run: [] };
      inRun = false;
      continue;
    }
    if (!current) continue;

    const shellMatch = line.match(/^\s*shell:\s*(\S+)/);
    if (shellMatch) {
      current.shell = shellMatch[1];
      inRun = false;
      continue;
    }

    const runMatch = line.match(/^(\s*)run:\s*\|/);
    if (runMatch) {
      inRun = true;
      runIndent = runMatch[1].length;
      continue;
    }
    if (inRun) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.trim() === "" || indent > runIndent) {
        current.run.push(line);
        continue;
      }
      inRun = false;
    }
  }
  if (current) steps.push(current);
  return steps;
};

describe("release workflow shell contracts", () => {
  const release = read(".github/workflows/release.yml");

  it("declares `shell: bash` on any matrix step that uses POSIX-only syntax", () => {
    // The release matrix includes windows-latest; a POSIX `run:` block without
    // an explicit bash shell fails at parse time on the default pwsh shell and
    // only surfaces on a real (manually dispatched) release.
    assert.match(
      release,
      /os:\s*windows-latest/,
      "release matrix should still include a Windows runner (guard assumption)",
    );

    const offenders = extractSteps(release)
      .filter(
        (step) =>
          step.shell !== "bash" &&
          step.shell !== "pwsh" &&
          step.run.some((line) => POSIX_ONLY.some((re) => re.test(line))),
      )
      .map((step) => step.name);

    assert.deepStrictEqual(
      offenders,
      [],
      `These release steps use POSIX-only shell syntax without 'shell: bash': ${offenders.join(", ")}`,
    );
  });

  it("pins bash on the cross-platform 'Build Tauri app' step", () => {
    const buildStep = extractSteps(release).find(
      (step) => step.name === "Build Tauri app",
    );
    assert.ok(buildStep, "release workflow must keep a 'Build Tauri app' step");
    assert.equal(
      buildStep.shell,
      "bash",
      "'Build Tauri app' runs on windows-latest and must opt into bash",
    );
  });
});
