import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

// POSIX-only shell tokens that pwsh (the default `run:` shell on
// windows-latest) cannot parse. `then`/`fi`/`elif` anchor to line start —
// the bare word boundary would also match English prose inside echo strings.
const POSIX_ONLY = [/\bif\s*\[/, /^\s*elif\b/m, /^\s*fi\b/m, /^\s*then\b/m];

// Extract the steps of a workflow file as { name, shell, shells, run } records.
// The release workflow pins structure by convention (steps are `- name:`
// entries with an optional `shell:` and a `run: |` block), so a line scanner
// is enough and keeps this test dependency-free.
const extractSteps = (workflowText) => {
  const lines = workflowText.split("\n");
  /** @type {{ name: string, shell: string | null, shells: string[], run: string[] }[]} */
  const steps = [];
  let current = null;
  let inRun = false;
  let runIndent = 0;

  for (const line of lines) {
    const stepMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (stepMatch) {
      if (current) steps.push(current);
      current = { name: stepMatch[1], shell: null, shells: [], run: [] };
      inRun = false;
      continue;
    }
    if (!current) continue;

    const shellMatch = line.match(/^\s*shell:\s*(\S+)/);
    if (shellMatch) {
      current.shell = shellMatch[1];
      current.shells.push(shellMatch[1]);
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

  it("secret-scan pull_request trigger is not restricted to main (stacked PRs)", () => {
    // This repo's review chain lands on feature branches (#109 -> #63 ->
    // #127); a `branches: [main]` filter would silently skip scanning them.
    const scan = read(".github/workflows/secret-scan.yml");
    const trigger = scan.match(/pull_request:\s*\{([^}]*)\}/)?.[1] ?? null;
    assert.ok(
      trigger !== null && !/branches\s*:/.test(trigger),
      "secret-scan.yml must keep a bare `pull_request` trigger with no branches filter",
    );
  });

  it("does not duplicate a step's shell key", () => {
    // YAML duplicate keys are invalid configuration. A last-value-wins parser
    // can hide the mistake locally, then leave the release workflow rejected
    // or misread by another parser.
    const duplicateShellSteps = extractSteps(release)
      .filter((step) => step.shells.length > 1)
      .map((step) => step.name);
    assert.deepStrictEqual(
      duplicateShellSteps,
      [],
      `Release steps must declare shell only once: ${duplicateShellSteps.join(", ")}`,
    );
  });

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

  it("uses strict SemVer classification instead of treating every hyphen as a prerelease", () => {
    const eligibility = extractSteps(release).find(
      (step) => step.name === "Resolve updater manifest eligibility",
    );
    assert.ok(
      eligibility,
      "release workflow must resolve updater manifest eligibility before publishing",
    );
    const command = eligibility.run.join("\n");
    assert.match(
      command,
      /node scripts\/ci\/validate-release-inputs\.mjs --print-prerelease/,
      "eligibility must use the shared strict-SemVer classifier",
    );
    assert.doesNotMatch(
      command,
      /case "\$RELEASE_VERSION"/,
      "a shell hyphen glob incorrectly calls stable build metadata a prerelease",
    );
  });

  it("cryptographically verifies every updater bundle before publishing latest.json", () => {
    const verification = extractSteps(release).find(
      (step) =>
        step.name ===
        "Verify updater signatures against the shipped trust anchor",
    );
    assert.ok(
      verification,
      "stable releases must verify artifact signatures against UPDATER_PUBLIC_KEY",
    );
    const command = verification.run.join("\n");
    assert.equal(verification.shell, "bash");
    assert.match(command, /UPDATER_PUBLIC_KEY/);
    assert.match(
      command,
      /printf '%s' "\$UPDATER_PUBLIC_KEY" \| base64 --decode > "\$PUBLIC_KEY_FILE"/,
    );
    assert.match(
      command,
      /bundle="\$\{signature%\.sig\}"/,
      "the artifact a signature covers is the signature path minus its suffix",
    );
    assert.match(
      command,
      /base64 --decode < "\$signature" > "\$signature_file"/,
    );
    assert.match(
      command,
      /minisign -Vm "\$bundle" -x "\$signature_file" -p "\$PUBLIC_KEY_FILE"/,
    );
    assert.match(command, /No updater signatures found to verify/);

    // The signed set is the pinned CLI's updater artifacts plus the `.dmg` the
    // job signs itself. The bare `.msi`, `.exe` and `.deb` next to them are the
    // manual-download installers and carry no `.sig`, so demanding one per
    // recognized suffix failed every stable release before it published. The
    // loop has to start from the signatures and check each one instead.
    assert.match(
      command,
      /find dist -type f -name '\*\.sig' -print0/,
      "verification must walk the signatures, not the installer suffixes",
    );
    assert.doesNotMatch(
      command,
      /-name '\*\.msi' -o|-name '\*\.exe' -o/,
      "unsigned manual-download installers must not be required to have a signature",
    );

    const verificationOffset = release.indexOf(
      "- name: Verify updater signatures against the shipped trust anchor",
    );
    const manifestOffset = release.indexOf("- name: Build updater manifest");
    assert.ok(
      verificationOffset >= 0 && manifestOffset > verificationOffset,
      "verification must precede updater-manifest generation",
    );
  });

  it("passes every dispatch input through env, never into a run body", () => {
    // CKV_GHA_7 exists for a real reason: `${{ inputs.x }}` written into a
    // `run:` block is substituted before the shell sees it, so a dispatch input
    // can inject shell. This workflow passes each one through `env:` and reads
    // it as a shell variable, which is what the rule is asking for. Pin the
    // property that makes that true: an `inputs.` interpolation may only appear
    // as an environment entry or in an `if:` condition, never in a script.
    for (const [index, line] of release.split("\n").entries()) {
      if (!line.includes("${{ inputs.")) continue;
      const isEnvEntry = /^\s+[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{\s*inputs\./.test(
        line,
      );
      const isCondition = /^\s*(if|!if):/.test(line.trimStart());
      assert.ok(
        isEnvEntry || isCondition,
        `release.yml:${index + 1} interpolates a dispatch input outside env or an if:`,
      );
    }
  });

  it("grants the workflow token read-only unless a job asks for more", () => {
    // The token defaults to write-all when nothing says otherwise, so a
    // workflow with no grant at all is the widest grant available. Every
    // workflow declares a read-only default and every job that needs more
    // declares its own block, which replaces the default.
    for (const file of [
      "release.yml",
      "lint-desktop.yml",
      "test-desktop-unit.yml",
      "build-desktop.yml",
      "secret-scan.yml",
      "test-package-rust-transcription.yml",
      "test-desktop-integration.yml",
      "test-docs.yml",
    ]) {
      const workflow = read(`.github/workflows/${file}`);
      const beforeJobs = workflow.split(/^jobs:$/m)[0];
      assert.match(
        beforeJobs,
        /^permissions:\n {2}contents: read$/m,
        `${file} must default the token to read-only before its jobs`,
      );
    }
  });

  it("builds both channels through one manifest step", () => {
    const builders = extractSteps(release).filter((step) =>
      step.run
        .join("\n")
        .includes("node scripts/ci/build-updater-manifest.mjs"),
    );
    assert.equal(builders.length, 1);
    assert.match(
      release,
      /OUTPUT_PATH: \$\{\{ steps\.manifest\.outputs\.output_path \}\}/,
    );
  });

  it("enforces protected release environment on jobs exposing signing keys", () => {
    assert.match(
      release,
      /build:[\s\S]*?environment:\s*release/,
      "build job must require 'environment: release'",
    );
    assert.match(
      release,
      /publish:[\s\S]*?environment:\s*release/,
      "publish job must require 'environment: release'",
    );
  });

  it("enforces ref guard rejecting refs other than refs/heads/main", () => {
    const steps = extractSteps(release);
    const refGuardSteps = steps.filter(
      (s) => s.name === "Assert release ref is main",
    );
    assert.ok(
      refGuardSteps.length >= 3,
      "release workflow must enforce ref guard across jobs",
    );
    for (const step of refGuardSteps) {
      assert.equal(step.shell, "bash");
      const cmd = step.run.join("\n");
      assert.match(cmd, /refs\/heads\/main/);
    }
  });

  it("checks out trusted main ref before exposing key material", () => {
    assert.match(
      release,
      /Checkout source[\s\S]*?ref:\s*refs\/heads\/main/,
      "build checkout must explicitly pin refs/heads/main",
    );
  });

  for (const [version, prerelease, file] of [
    ["1.2.3+build-foo", "false", "latest.json"],
    ["1.2.3-rc.1", "true", "latest-beta.json"],
  ]) {
    for (const missingKey of [
      null,
      "UPDATER_PRIVATE_KEY",
      "UPDATER_PUBLIC_KEY",
    ]) {
      it(`${version} uses the shared fail-closed gate (${missingKey ?? "signed"})`, () => {
        const directory = mkdtempSync(resolve(tmpdir(), "release-gate-"));
        const output = resolve(directory, "output");
        try {
          const command = extractSteps(release)
            .find(
              (step) => step.name === "Resolve updater manifest eligibility",
            )
            .run.join("\n");
          const env = {
            ...process.env,
            RELEASE_VERSION: version,
            RELEASE_PRERELEASE: prerelease,
            UPDATER_PRIVATE_KEY: "placeholder-not-a-key",
            UPDATER_PUBLIC_KEY: "placeholder-not-a-key",
            GITHUB_OUTPUT: output,
          };
          if (missingKey) env[missingKey] = "";
          const result = spawnSync(
            "bash",
            ["-e", "-o", "pipefail", "-c", command],
            {
              cwd: repoRoot,
              env,
              encoding: "utf8",
            },
          );
          const published = existsSync(output)
            ? readFileSync(output, "utf8")
            : "";
          if (missingKey) {
            assert.notEqual(result.status, 0);
            assert.doesNotMatch(published, /eligible=true/);
          } else {
            assert.equal(result.status, 0, result.stderr);
            assert.match(published, /eligible=true/);
            assert.ok(published.includes(`output_path=dist/${file}`));
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});
