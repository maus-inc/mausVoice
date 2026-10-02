import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = resolve(repoRoot, ".github/workflows");
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

// The key of the mapping a line sits inside, or "" at the top level. Found by
// walking up past blank lines to the first line indented less than `indent`.
function enclosingKey(lines, index, indent) {
  for (let above = index - 1; above >= 0; above -= 1) {
    const line = lines[above];
    if (line.trim() === "") continue;
    const aboveIndent = line.length - line.trimStart().length;
    if (aboveIndent >= indent) continue;
    return line.trim().replace(/:.*$/, "");
  }
  return "";
}

// The jobs of a workflow as { name, body } records, so a guard can prove a
// property of one job instead of of the whole file read as a single string.
function jobBlocks(workflowText) {
  const lines = workflowText.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  // A workflow with no `jobs:` section has nothing to check, and a scanner that
  // silently returned an empty list would let the caller conclude every job
  // declared its permissions -- including for a file that has no jobs at all.
  if (jobsAt === -1) return [];
  const jobs = [];
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (start) {
      current = { name: start[1], body: [] };
      jobs.push(current);
      continue;
    }
    current?.body.push(line);
  }
  return jobs.map((job) => ({ ...job, body: job.body.join("\n") }));
}

// This is the guard: every job declares its own permissions, and a scan that
// found no jobs at all is a failure rather than an empty result.
//
// It takes the workflow text rather than reading a file so a test can hand it a
// shape the repository does not currently contain. That is the whole point: a
// guard whose only exercise is today's workflows cannot be shown to fail, and a
// guard that has never been seen to fail is a guard nobody can rely on.
function assertEveryJobDeclaresPermissions(workflowText, label) {
  const jobs = jobBlocks(workflowText);
  assert.ok(
    jobs.length > 0,
    `${label} has a jobs: section this scan cannot read, so its jobs' ` +
      "permissions blocks were never verified",
  );
  const undeclared = jobs
    .filter((job) => !/^ {4}permissions:/m.test(job.body))
    .map((job) => job.name);
  assert.deepStrictEqual(
    undeclared,
    [],
    `${label}: every job must declare its own permissions, or it inherits ` +
      `none: ${undeclared.join(", ")}`,
  );
}

// The nearest enclosing step's `uses:` pin, looking upward from `index`, or null.
function enclosingUsesPin(lines, index) {
  for (let above = index - 1; above >= 0; above -= 1) {
    const uses = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(lines[above]);
    if (uses) return uses[1];
  }
  return null;
}

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
    // `.deb` belongs in that list as much as `.msi` and `.exe`: Tauri v2 emits
    // no detached signature for it (see the INSTALLER_TYPES note in
    // build-updater-manifest.mjs), so a `-name '*.deb'` arm would fail every
    // stable release for a signature nobody produces.
    assert.doesNotMatch(
      command,
      /-name '\*\.(?:msi|exe|deb)'/,
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
    // property that makes that true: an `inputs.` interpolation may reach an
    // `env:` entry, an `if:` condition, or the `with:` block of an action that
    // is pinned to a commit, and nothing else.
    //
    // The shape of the line is not enough to tell those apart, because a `with:`
    // entry looks exactly like an `env:` entry:
    // `prerelease: ${{ inputs.prerelease }}` at release.yml:620 is a parameter of
    // `softprops/action-gh-release`, which is handed the value as an argument and
    // never splices it into a script. So the enclosing block is read from the
    // line above, at the key's own indentation, and a `with:` entry has to prove
    // that the action it belongs to is pinned before it counts as safe.
    const lines = release.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes("${{ inputs.")) continue;
      const indent = line.length - line.trimStart().length;
      const key = line.trim().replace(/\s*:.*$/, "");
      const block = enclosingKey(lines, index, indent);
      const isEnvEntry =
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && block === "env";
      const isCondition = /^\s*(if|!if):/.test(line.trimStart());
      const isPinnedStepParameter =
        block === "with" &&
        /@[0-9a-f]{40}$/.test(enclosingUsesPin(lines, index) ?? "");
      assert.ok(
        isEnvEntry || isCondition || isPinnedStepParameter,
        `release.yml:${index + 1} interpolates a dispatch input outside an env: entry, an if:, or a pinned action parameter`,
      );
    }
  });

  it("grants each job only the token scope it declares", () => {
    // Per-job least privilege, which is the rule the repository states: every
    // job declares what it needs, and the workflow-level default grants
    // nothing at all. The default has to be `{}` rather than `contents: read`
    // because a read default still hands a token to a job that needs none, and
    // it has to be `{}` rather than nothing because GitHub's own default is
    // write-all: a job added tomorrow without a `permissions:` block would
    // otherwise inherit write access. `{}` is what makes the missing block fail
    // loudly instead of quietly.
    //
    // The list comes from the directory rather than from a hand-maintained
    // array: a workflow added later is then covered the day it lands, and the
    // one added a moment ago, `format-and-i18n.yml`, cannot be the one that
    // quietly loses its default.
    const workflows = readdirSync(workflowDir).filter((file) =>
      /\.ya?ml$/.test(file),
    );
    assert.ok(
      workflows.length > 0,
      "expected at least one workflow in .github/workflows",
    );

    for (const file of workflows) {
      const workflow = readFileSync(join(workflowDir, file), "utf8");
      assert.match(
        workflow.split(/^jobs:$/m)[0],
        /^permissions: \{\}$/m,
        `${file} must default the token to no permissions before its jobs`,
      );
      assertEveryJobDeclaresPermissions(workflow, file);
    }
  });

  // A guard that cannot fail is worse than no guard, because it is read as
  // evidence. Both shapes below pass a naive `deepStrictEqual(undeclared, [])`
  // while checking nothing at all.
  it("refuses a workflow whose jobs it cannot see", () => {
    // Jobs indented four spaces instead of two. Every job here declares nothing,
    // and the old comparison saw an empty list, compared it to an empty list and
    // passed -- so a workflow reformatted by a well-meaning edit would have
    // switched this guard off without a word.
    const deep = [
      "permissions: {}",
      "jobs:",
      "    build:",
      "      runs-on: ubuntu-latest",
      "      steps:",
      "        - run: echo hi",
      "",
    ].join("\n");
    assert.throws(
      () => assertEveryJobDeclaresPermissions(deep, "deep.yml"),
      /cannot read/,
      "no readable job means no verified job, which has to be a failure",
    );
    // And the reason it used to pass is still true of the scan itself: the
    // blindness is in `jobBlocks`, not in the assertion.
    assert.deepStrictEqual(jobBlocks(deep), []);
  });

  it("refuses a workflow with no jobs section at all", () => {
    assert.throws(
      () => assertEveryJobDeclaresPermissions("name: nothing\n", "empty.yml"),
      /cannot read/,
    );
  });

  it("reports a job with no permissions block, and only that job", () => {
    const workflow = [
      "permissions: {}",
      "jobs:",
      "  declared:",
      "    runs-on: ubuntu-latest",
      "    permissions:",
      "      contents: read",
      "    steps:",
      "      - run: echo hi",
      "  bare:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi",
      "",
    ].join("\n");
    assert.throws(
      () => assertEveryJobDeclaresPermissions(workflow, "mixed.yml"),
      /bare/,
      "the job that inherits the workflow default is the one to name",
    );
    // And the same workflow passes once that job declares its own.
    assert.doesNotThrow(() =>
      assertEveryJobDeclaresPermissions(
        workflow.replace(
          "  bare:\n    runs-on: ubuntu-latest\n",
          "  bare:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n",
        ),
        "fixed.yml",
      ),
    );
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
