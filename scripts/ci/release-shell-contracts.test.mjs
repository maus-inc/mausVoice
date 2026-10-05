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
  /** @type {{ name: string, uses: string | null, shell: string | null, shells: string[], run: string[],
   *          inputs: string[], if: string | null, workingDirectory: string | null }[]} */
  const steps = [];
  let current = null;
  let inRun = false;
  let runIndent = 0;
  let inWith = false;
  let withIndent = 0;

  for (const line of lines) {
    const stepMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (stepMatch) {
      if (current) steps.push(current);
      current = {
        name: stepMatch[1],
        shell: null,
        shells: [],
        run: [],
        inputs: [],
        uses: null,
        if: null,
        workingDirectory: null,
      };
      inRun = false;
      continue;
    }
    if (!current) continue;

    const runMatch = line.match(/^(\s*)run:\s*\|/);
    if (runMatch) {
      inRun = true;
      runIndent = runMatch[1].length;
      continue;
    }

    // A single-line `run:`. This parser used to capture only the `run: |` block form, so
    // every `step.run` assertion in this file was silently blind to any step written
    // inline -- and the three steps this branch's ordering turns on are exactly that.
    // A check that cannot see half the steps is worse than none, because it reports a
    // coverage it does not have.
    const inlineRun = line.match(/^\s*run:\s*(\S.*?)\s*$/);
    if (inlineRun) {
      current.run.push(inlineRun[1]);
      inRun = false;
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

    // Step-level keys, read together and only once the run-body block above has had its
    // say -- so a line inside a `run: |` body cannot be taken for a key.
    //
    // Unconditional, and that is load-bearing rather than sloppy. A line inside a `run: |`
    // body cannot reach here: the block above `continue`s on it when it is blank or more
    // indented than the `run:` key, and clears `inRun` on a dedent. So a guard here used to
    // read `if (!inRun)`, which DeepScan was right about -- it is always true, because
    // arriving here already means `inRun` is false.
    //
    // The property that guard was written to protect is real, and it is the `continue` above
    // rather than the condition. Reinstating the guard would add a check that cannot fail,
    // which reads as protection and is not.
    //
    // `shell:` used to be read up beside `run:`, before any of this. That was a real bug and
    // not a theoretical one: a `shell:` line inside a run body was taken for the step's shell
    // AND cleared `inRun`, so every line after it in that body was read as a step key too. No
    // workflow here has such a line -- measured, 0 across `.github/workflows/*.yml` -- so it
    // never fired; `does not read a step key out of a run: | body` now covers it.
    //
    const ifMatch = line.match(/^\s*if:\s*(.+?)\s*$/);
    if (ifMatch) {
      current.if = ifMatch[1];
      continue;
    }
    // A step's `uses:` is recorded for the same reason `with:` is: a step that calls a
    // local action executes code from the scanned checkout and has NO `run:` body for an
    // assertion to read. Without this, `uses: ./.github/actions/...` before the secret-scan
    // verdict was invisible to every check here -- measured, inserting one left the suite
    // at 30/30. Read beside `if:`, so a `uses:` inside a run body cannot be mistaken for
    // the step's key, which is the same reason `shell:` was moved.
    const usesMatch = line.match(/^\s*uses:\s*(\S+)\s*$/);
    if (usesMatch) {
      current.uses = usesMatch[1];
      continue;
    }
    const wdMatch = line.match(/^\s*working-directory:\s*(.+?)\s*$/);
    if (wdMatch) {
      current.workingDirectory = wdMatch[1];
      continue;
    }
    // The `with:` block, recorded because a step's INPUTS are as much a part of what it
    // does as its run body, and one assertion could not be written without them: the
    // trusted checkout's `ref:` lives there, and until now the only way to assert on it
    // was to match the whole file -- which any step carrying the same string satisfies.
    // Collected as raw lines, not parsed into a map: nothing needs the keys separately,
    // and a parsed map would commit this parser to a YAML reader it does not have.
    const withMatch = line.match(/^(\s*)with:\s*$/);
    if (withMatch) {
      inWith = true;
      withIndent = withMatch[1].length;
      continue;
    }
    if (inWith) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.trim() === "" || indent > withIndent) {
        current.inputs.push(line);
        continue;
      }
      inWith = false;
    }
    const shellMatch = line.match(/^\s*shell:\s*(\S+)/);
    if (shellMatch) {
      current.shell = shellMatch[1];
      current.shells.push(shellMatch[1]);
      continue;
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

  // Five workflows carried one shared sentence saying they run on "branch pushes or
  // manual requests". Four of them declare no `workflow_dispatch`, so for those it was
  // false; `test-docs` does declare it, so a single corrected sentence cannot serve both.
  // A comment is invisible to every other gate, which is why this needs pinning: the
  // first fix I wrote was itself false for `test-docs` and only a validator that reads
  // each file's own `on:` block caught it.
  // In its own `it`, not loose in the describe body. A throw here aborts COLLECTION, and
  // node's test runner then reports every test as `cancelledByParent` with the real
  // assertion demoted to a suite-level error: proven by mutation, `# pass 0  # fail 0`,
  // with all 29 checks offline because one workflow's comment disagreed with its own
  // `on:` block. A red herring that looks like "one thing is broken" while actually
  // meaning "nothing was verified" is worse than a missing check. Wrapping it makes the
  // same mutation 1 named failure and 28 passes.
  it("every trigger comment agrees with its own on: block", () => {
    for (const file of [
      "build-desktop",
      "lint-desktop",
      "test-desktop-integration",
      "test-desktop-unit",
      "test-docs",
    ]) {
      const text = read(`.github/workflows/${file}.yml`);
      const on = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(text);
      assert.ok(on, `${file}.yml must have an on: block`);
      // The `on:` block only: a `workflow_dispatch:` key appearing in a comment or in
      // a job's `if:` would otherwise satisfy this and pin nothing.
      const declaresManual = /^\s*workflow_dispatch:/m.test(on[1]);
      // The claim comes from a machine-readable marker beside the `on:` block, never
      // from the prose. Every version of this assertion that read the comment text
      // broke the moment the comment was reworded -- which is not a change to the
      // `on:` block at all, and happened three times while writing these comments.
      // Reading prose also cannot work here: a corrected comment still quotes the
      // old sentence while explaining it, so any phrase search for the claim finds
      // the history rather than the assertion.
      const marker = /^#\s*trigger-manual:\s*(true|false)\s*$/m.exec(text);
      assert.ok(
        marker,
        `${file}.yml must carry a "# trigger-manual: true|false" line beside its on: ` +
          `block, so this contract never has to interpret prose`,
      );
      const claimsManual = marker[1] === "true";

      assert.equal(
        declaresManual,
        claimsManual,
        `${file}.yml: its trigger comment must agree with its own on: block ` +
          `(declares workflow_dispatch: ${declaresManual})`,
      );
    }
  });
  // The capability check, as it appears in the three scans and in the verdict.
  //
  // Compared as the WHOLE BLOCK, from `active=0` to the `fi` closing the inert arm.
  //
  // An earlier version compared only the awk PROGRAM, on the stated ground that the
  // three scans feed it a path while the verdict feeds it a blob, so their `if` lines
  // differ by construction. That ground stopped being true when the verdict stopped
  // re-deriving the blob in the pipeline: all four now open with the same
  // `if awk '...' "$TRUSTED_POLICY"`, and the only real difference between the scans and
  // the verdict is what the inert arm DOES -- the scans skip, the verdict exits 1.
  //
  // Comparing the program alone therefore left the whole of the scaffolding unpinned,
  // and the scaffolding is where the decision lives. Measured: flipping one scan's
  // `active=1` to `active=0` leaves all four programs byte-identical, so that assertion
  // reported 30/30 on a gate that would never have activated in that scan.
  const capabilityBlocks = (text) => {
    const lines = text.split("\n");
    const blocks = [];
    let afterClose = -1;
    for (let i = 0; i < lines.length; i += 1) {
      // Skip lines inside a block already collected, so a second `active=0` further
      // down the same arm cannot register as another copy.
      if (i <= afterClose) continue;
      if (!/^\s*active=0\s*$/.test(lines[i])) continue;
      let opened = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (/^\s*if \[ "\$active" -ne 1 \]; then\s*$/.test(lines[j])) {
          opened = j;
          break;
        }
      }
      if (opened === -1) continue;
      // Line-anchored, because the comments inside the arm contain prose that ends in
      // the word `fi` -- the same reason `4175584793` needed a line-anchored close.
      let closed = -1;
      for (let j = opened + 1; j < lines.length; j += 1) {
        if (/^\s*fi\s*$/.test(lines[j])) {
          closed = j;
          break;
        }
      }
      if (closed === -1) continue;
      const body = lines.slice(i, closed + 1);
      blocks.push({
        text: body.join("\n"),
        // Whether this copy's inert arm ends the STEP rather than skipping the scan.
        exits: /^\s*exit 1\s*$/.test(body[body.length - 2] ?? ""),
        startLine: i + 1,
      });
      afterClose = closed;
    }
    return blocks;
  };

  // Ordering, asserted POSITIVELY. Every other check in this file asks whether the verdict
  // reads the right BYTES; this one asks whether the branch has had a chance to change them
  // first, which no amount of correct resolution answers.
  //
  // The verdict's two inputs are `../trusted-scanner/.git`, read through `git cat-file`, and
  // `../trusted-scanner/gitleaks.toml`. `cat-file blob <rev>:<path>` does NOT re-hash what it
  // reads, so bytes planted at `.git/objects/<2>/<38>` come back verbatim -- measured on git
  // 2.43.0, returning forged content with exit 0. The `cmp -s` between the object and the
  // working tree therefore only ever caught an edit to ONE side, and forging both is two
  // writes. Three steps resolve `node scripts/ci/*.mjs` out of the SCANNED checkout, which is
  // the branch under review running as the uid that owns `trusted-scanner/`.
  //
  // Measured by running this job's real verdict body against a real two-checkout layout:
  //
  //     capable base, nothing touched                exit 0   correct
  //     inert base, nothing touched                  exit 1   correct
  //     inert base, object AND tree forged alike     exit 0   the hole
  //
  // So the verdict now runs BEFORE those three. That reverses the old comment's reasoning --
  // it said the verdict had to come last so an inert-policy skip could not make the
  // self-verification steps unreachable -- which was true and cost the integrity of the files
  // the verdict reads. `if: always()` on each of the three buys the reachability back without
  // depending on order, and is asserted below.
  // The parser, on the shape it has to get right for the assertion below to mean anything.
  //
  // DeepScan reported the `if (!inRun)` guard as a constant condition. It was one: a line
  // inside a `run: |` body is always handled by the block above, which either `continue`s or
  // clears `inRun` on a dedent, so the guard could never be false when reached. It is gone,
  // and what does the protecting is the `continue` -- which is structural, not conditional.
  //
  // That left the property unpinned: lifting these two key reads above the run-body handling
  // left all 28 tests green. Nothing in this repository has a run body containing a
  // key-shaped line either -- measured, 0 across `.github/workflows/*.yml` -- so no real
  // workflow exercises it. This fixture does.
  it("does not read a step key out of a run: | body", () => {
    const steps = extractSteps(
      [
        "name: synthetic",
        "on: [push]",
        "jobs:",
        "  probe:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: outer",
        "        shell: bash",
        "        run: |",
        "          echo start",
        "          if: [ -f /tmp/x ]",
        "          working-directory: /tmp",
        "          shell: not-a-real-key",
        "          name: not-a-real-name",
        "          echo end",
        "      - name: next",
        "        if: always()",
        "        working-directory: scan-target",
        "        run: echo second",
        "",
      ].join("\n"),
    );

    const outer = steps.find((step) => step.name === "outer");
    assert.ok(outer, "the step with a block body must be found");
    // The key-shaped lines belong to the body and must be IN it ...
    const body = outer.run.join("\n");
    for (const line of [
      "if: [ -f /tmp/x ]",
      "working-directory: /tmp",
      "shell: not-a-real-key",
      "name: not-a-real-name",
    ]) {
      assert.ok(
        body.includes(line),
        `the run body must keep ${JSON.stringify(line)} as body text, not a step key`,
      );
    }
    // ... so the step's own keys are the ones written outside the body.
    assert.equal(
      outer.if,
      null,
      "a key-shaped line in the body is not the step's `if`",
    );
    // `shell` and `shells` too, and the assertion is the step's OWN value rather than a
    // null. This fixture is the only thing pinning that a key-shaped line in a run body is
    // not the step's shell, and it asserted neither field -- so the parser could read
    // `shell:` out of the body, let it overwrite the real `shell: bash` written above the
    // body, and stay green. Proven by mutation: 30/30 with the body-text push still
    // present. The body-text assertion is what caught the ORIGINAL bug, which is exactly
    // why the shell half of it went unnoticed as unpinned.
    assert.equal(
      outer.shell,
      "bash",
      "a key-shaped line in the body must not become the step's `shell`; the step's own " +
        "`shell: bash`, written above the body, is the only shell it has",
    );
    assert.deepEqual(
      outer.shells,
      ["bash"],
      "`shells` carries the step's own shell once and nothing from the body",
    );
    assert.equal(
      outer.workingDirectory,
      null,
      "a key-shaped line in the body is not the step's `working-directory`",
    );

    // And the control: a real key AFTER the body is still read. Without this the case above
    // would also pass if the parser simply stopped reading keys altogether.
    const next = steps.find((step) => step.name === "next");
    assert.ok(next, "the following step must be found");
    assert.equal(next.if, "always()");
    assert.equal(next.workingDirectory, "scan-target");
    assert.deepEqual(next.run, ["echo second"]);
  });

  it("runs no step from the scanned checkout before the verdict reads the trusted one", () => {
    const scan = read(".github/workflows/secret-scan.yml");
    const steps = extractSteps(scan);
    const verdictIndex = steps.findIndex((step) =>
      step.name.startsWith("Require a secret-scan policy"),
    );
    assert.ok(
      verdictIndex >= 0,
      "secret-scan.yml needs the closing verdict step",
    );

    // The subject is a POSITION, not a launcher.
    //
    // This used to select steps by matching `node|npx|bun|deno ... scripts/ci/`, which
    // is a list of interpreters rather than the thing the contract is about. Measured
    // misses, all of which execute branch code out of the scanned checkout just as
    // effectively:
    //
    //     sh scripts/ci/branch-helper.sh          not matched
    //     bash scripts/ci/branch-helper.sh        not matched
    //     ./scripts/ci/run                        not matched
    //     bash -c "node scripts/ci/x.mjs"         not matched
    //
    // and a pre-verdict `uses: ./.github/actions/...` composite action does not even have
    // a `run:` body to match. Proven by mutation: inserting two such steps before the
    // verdict -- one `sh` under `working-directory: scan-target`, one composite action --
    // left the suite at 30/30.
    //
    // So the subject is: every step whose working directory is the scanned checkout,
    // split by which side of the verdict it sits on. What runs there is a separate,
    // positive question, asked per step below.
    const inScanTarget = (step) => step.workingDirectory === "scan-target";
    const beforeVerdict = steps.filter(
      (step, index) => inScanTarget(step) && index < verdictIndex,
    );
    const afterVerdict = steps.filter(
      (step, index) => inScanTarget(step) && index > verdictIndex,
    );

    // Positive control on both halves, so neither can pass by being empty.
    assert.equal(
      afterVerdict.length,
      3,
      "expected the three config-guard/history-scan steps to run from the scanned " +
        "checkout after the verdict; a different count means this assertion has lost " +
        "its subject",
    );
    assert.ok(
      beforeVerdict.length >= 3,
      `expected at least the three scans to run from the scanned checkout before the ` +
        `verdict, found ${beforeVerdict.length}`,
    );

    // Before the verdict, running anything from the scanned checkout at all is the
    // hazard -- the branch under review owns those bytes and can forge both inputs the
    // verdict compares. A composite action is the same hazard with no `run:` to inspect.
    for (const [index, step] of steps.entries()) {
      if (index >= verdictIndex) continue;
      assert.doesNotMatch(
        step.run.join("\n"),
        /(?:^|[\s;&|(])(?:node|npx|bun|deno|sh|bash|zsh|python3?|ruby|perl)\s[^\n]*scripts\/ci\//,
        `${step.name} runs BEFORE the verdict and resolves scripts/ci/ out of the ` +
          "scanned checkout, so the branch under review can forge both inputs the " +
          "verdict compares (../trusted-scanner/.git and ../trusted-scanner/gitleaks.toml)",
      );
      assert.doesNotMatch(
        step.run.join("\n"),
        /(?:^|\s)\.?\/?\.github\/actions\//,
        `${step.name} runs BEFORE the verdict and uses a local composite action from the ` +
          "scanned checkout, which is branch code with no `run:` body to read",
      );
      assert.doesNotMatch(
        step.uses ?? "",
        /^\.\//,
        `${step.name} runs BEFORE the verdict and uses a local action (${step.uses}), ` +
          "which is code from the branch under review executing before the verdict",
      );
    }

    // And after the verdict, running from the scanned checkout is the POINT -- the
    // branch's own tests. Those must stay reachable whatever the verdict decided.
    const branchCode = afterVerdict;
    for (const step of beforeVerdict) {
      assert.ok(
        !/(?:^|\s)(?:node|npx|bun|deno|sh|bash)\s[^\n]*scripts\/ci\//.test(
          step.run.join("\n"),
        ),
        `${step.name} is a scan, not a test: it must not resolve scripts/ci/ out of the ` +
          "checkout it is scanning",
      );
    }

    // The verdict step's own working directory, which nothing above pins. The loop below
    // checks the three scans and the verdict is not one of them: its body does not
    // resolve `scripts/ci/`, so it never enters `branchCode`. Yet the verdict reads
    // `../trusted-scanner/gitleaks.toml` RELATIVE to itself, so without
    // `working-directory: scan-target` that path leaves $GITHUB_WORKSPACE, the resolver
    // fails closed, and every run reports a clean scan. A gate that is permanently
    // broken and permanently green is worse than no gate, because it reads as coverage.
    assert.equal(
      steps[verdictIndex].workingDirectory,
      "scan-target",
      "the verdict resolves ../trusted-scanner/gitleaks.toml relative to its own working " +
        "directory, so it must carry working-directory: scan-target; without it every run " +
        "fails closed and the suite still passes",
    );

    for (const step of branchCode) {
      const index = steps.indexOf(step);
      assert.ok(
        index > verdictIndex,
        `${step.name} resolves scripts/ci/ out of the scanned checkout and runs BEFORE the ` +
          `verdict, so the branch under review can forge both inputs the verdict compares ` +
          "(../trusted-scanner/.git and ../trusted-scanner/gitleaks.toml) and make an inert " +
          "base policy read as capable",
      );
      // The reachability the old ordering was there to buy, now bought by `if:`.
      assert.equal(
        step.if,
        "always()",
        `${step.name} runs branch code and must keep if: always(), or a failing verdict ` +
          "makes it unreachable -- which is what the ordering used to guarantee",
      );
      assert.equal(
        step.workingDirectory,
        "scan-target",
        `${step.name} is expected to run from the scanned checkout; if that changes, this ` +
          "assertion is no longer looking at the step it was written for",
      );
    }

    // And the verdict itself must not EXECUTE anything out of the scanned checkout.
    //
    // Matched against code lines only. This verdict's own comment explains the hazard by
    // name, so it contains the string `scripts/ci/` several times in prose; a `doesNotMatch`
    // over the raw body fails on the explanation. That is the same trap as a `grep -c` over
    // a directory of commented-out code -- the count describes the prose, not the code.
    const verdictCode = steps[verdictIndex].run
      .filter((line) => line.trim() === "" || !line.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(
      verdictCode,
      /(?:^|[\s;&|(])(?:node|npx|bun|deno)\s[^\n]*scripts\/ci\//,
      "the verdict must not execute anything out of the scanned checkout; it runs before " +
        "the three steps that do, and its own comment is not an exception",
    );
  });

  it("the verdict re-derives policy capability itself, crossing no step boundary", () => {
    // This job's verdict used to be a question about another step: the scans wrote a
    // sentinel file when they had to skip, and the closing step failed when it found
    // one. Two reviewers killed that, correctly and in this order. First the file
    // lived in $RUNNER_TEMP, which steps 12-14 (`node scripts/ci/*.mjs` run from the
    // SCANNED checkout, i.e. arbitrary code from the branch under review) could
    // `rm -rf`, so deleting one file turned an unscanned range green. Moving it into
    // the trusted checkout closed that and opened nothing: every step here runs as the
    // same uid, so `rm trusted-scanner/.inert-policy-sentinel` works identically -- and
    // so does WRITING it, which let a pull request fail a perfectly scannable base.
    // Either way, the pull request decided its own verdict.
    //
    // So the sentinel is gone rather than relocated, and the closing step answers the
    // capability question from the trusted checkout directly. Nothing crosses a step
    // boundary, so there is nothing for another step to delete or forge.
    const scan = read(".github/workflows/secret-scan.yml");
    const steps = extractSteps(scan);

    // 1. No sentinel survives anywhere: not declared, not written, not read.
    assert.doesNotMatch(
      scan,
      /^\s*INERT_SENTINEL:/m,
      "no step may publish INERT_SENTINEL: a file on disk is reachable by the " +
        "pull-request-controlled steps 12-14, which run as this job's uid",
    );
    for (const step of steps) {
      assert.doesNotMatch(
        step.run.join("\n"),
        /\$INERT_SENTINEL/,
        `${step.name} references INERT_SENTINEL; the verdict must not depend on a file`,
      );
    }

    const verdict = steps.find((step) =>
      step.name.startsWith("Require a secret-scan policy"),
    );
    assert.ok(verdict, "secret-scan.yml needs the closing verdict step");
    const body = verdict.run.join("\n");

    // 2. Every party to the gate resolves the trusted policy the SAME way.
    //
    //    Three wrong answers so far, in order, and each was introduced by the fix for
    //    the one before it:
    //
    //    (a) a file on disk that a later step could delete  -> an unscanned range went green
    //    (b) the same file, in a directory the branch cannot name -> nothing changed, because
    //        every step runs as the same uid
    //    (c) `git cat-file` for the VERDICT only, while the scans still read the tree
    //        -> worse than (a): the forgery suppressed findings in all three scans
    //        while the verdict read the real capable blob and exited 0
    //
    //    So the property is not "the verdict is content-addressed". It is that the three
    //    scans and the verdict all resolve the same bytes, by name, out of the base
    //    commit's object store, into a file the step itself owns.
    //
    //    The four resolver blocks are compared to each other WHOLE. Counting fragments
    //    is what this used to do -- five separate counts (the resolver, the ignore file,
    //    `2> "$POLICY_ERR"`, `cmp -s`, `POLICY_TMP=`) standing in for the byte-identity
    //    the workflow's own comment claims. Five counts cannot establish identity: a copy
    //    whose divergence guard reads `[ -f /etc/passwd ]` keeps every one of the five
    //    fragments and no longer compares the blob against the checkout at all.
    //    Measured: that mutation left this file at 30/30.
    const resolverBlocks = (source) => {
      const lines = source.split("\n");
      const blocks = [];
      let afterClose = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (i <= afterClose) continue;
        if (!/^\s*POLICY_DIR="\$\(mktemp -d\)"/.test(lines[i])) continue;
        let closed = -1;
        // The block ends at the `fi` that closes the DIVERGENCE GUARD, not at the first
        // `fi` after POLICY_DIR. The block holds three `if` blocks in sequence and the
        // first one closes on the `cat-file` failure; stopping there excludes the
        // `cmp -s` guard, which is the part the block exists for. Measured: a first-`fi`
        // version of this extractor returned 13 lines, and a copy whose divergence guard
        // had been rewritten still compared equal.
        let guard = -1;
        for (let j = i + 1; j < lines.length; j += 1) {
          // Never run past the capability gate, which is a different block entirely.
          if (/^\s*active=0\s*$/.test(lines[j])) break;
          if (/cmp -s /.test(lines[j])) {
            guard = j;
            break;
          }
        }
        if (guard !== -1) {
          for (let j = guard + 1; j < lines.length; j += 1) {
            // Line-anchored for the reason `4175584793` needed one -- prose above ends
            // in the word `fi`.
            if (/^\s*fi\s*$/.test(lines[j])) {
              closed = j;
              break;
            }
          }
        }
        if (closed === -1) continue;
        blocks.push({
          text: lines.slice(i, closed + 1).join("\n"),
          startLine: i + 1,
        });
        afterClose = closed;
      }
      return blocks;
    };

    const resolverBlocksFound = resolverBlocks(scan);
    assert.equal(
      resolverBlocksFound.length,
      4,
      "the trusted policy must be resolved into a step-owned file in all three scans " +
        `and in the verdict; found ${resolverBlocksFound.length} resolver blocks`,
    );
    const [firstResolver, ...otherResolvers] = resolverBlocksFound;
    for (const block of otherResolvers) {
      assert.equal(
        block.text,
        firstResolver.text,
        "the policy-resolution blocks have drifted apart, so the copies no longer " +
          "resolve the same bytes the same way (first starts at line " +
          `${firstResolver.startLine}, this one at line ${block.startLine})`,
      );
    }

    // The fragments stay asserted too: they are what the byte-identity is made of, and
    // a count is the right instrument for "this string appears N times" -- just not for
    // "these N blocks are the same block".
    const resolver =
      'git -C ../trusted-scanner cat-file blob "$POLICY_REF:gitleaks.toml" > "$POLICY_TMP"';
    assert.equal(
      [
        ...scan.matchAll(
          new RegExp(resolver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        ),
      ].length,
      4,
      "the policy must be resolved by name out of the base commit in all three scans " +
        "and in the verdict",
    );
    assert.doesNotMatch(
      scan,
      /TRUSTED_POLICY="\.\.\/trusted-scanner\/gitleaks\.toml"/,
      "no step may read the trusted policy off disk; the working tree is writable by " +
        "the pull-request-controlled steps",
    );
    // The baseline, by the same argument as the policy: a `.gitleaksignore` written
    // into the checkout by a later step suppresses findings just as effectively, and
    // the scan then reports the range clean. Asserted POSITIVELY -- a mutation that
    // swapped the resolution for a `cp` off disk left the ban on the old assignment
    // satisfied, because the assignment was never what made it readable.
    assert.equal(
      [...scan.matchAll(/cat-file blob "\$POLICY_REF:\.gitleaksignore"/g)]
        .length,
      3,
      "the baseline ignore file must be resolved by name from the base commit in all " +
        "three scans, or a written .gitleaksignore suppresses findings undetected",
    );

    // stderr must not be folded into the bytes the predicate parses
    assert.equal(
      [...scan.matchAll(/2> "\$POLICY_ERR"/g)].length,
      4,
      "git's stderr must be captured separately, not merged into the policy's bytes",
    );

    // and a rewrite of either side alone must be caught rather than absorbed
    assert.equal(
      [
        ...scan.matchAll(
          /cmp -s "\$POLICY_TMP" \.\.\/trusted-scanner\/gitleaks\.toml/g,
        ),
      ].length,
      4,
      "each resolver must compare the blob against the checkout and refuse on a difference",
    );

    // The resolved file's NAME is load-bearing, and a bare `mktemp` breaks the job.
    //
    // Gitleaks dispatches config parsing on the file extension. Given a path with none it
    // answers `Unsupported Config Type "<suffix>"` and exits 1 -- which the scan reads as
    // findings, so every scan failed on a perfectly capable base. The local job simulator
    // did not catch it because it stubbed gitleaks out; CI did.
    assert.equal(
      [...scan.matchAll(/POLICY_TMP="\$POLICY_DIR\/gitleaks\.toml"/g)].length,
      4,
      "the resolved policy must be named gitleaks.toml: gitleaks selects its config " +
        "parser by file extension and rejects an extensionless path",
    );
    assert.doesNotMatch(
      scan,
      /POLICY_TMP="\$\(mktemp\)/,
      "a bare mktemp path has no extension and gitleaks will not load it",
    );

    assert.match(
      body,
      /::error::Cannot read gitleaks\.toml at \$POLICY_REF/,
      "the verdict must say the pull request is unscanned when it cannot read the policy",
    );
    assert.match(
      body,
      /if \[ -s "\$POLICY_ERR" \]; then[\s\S]*?exit 1/,
      "diagnostics on an otherwise successful read must fail the job, not be ignored: " +
        "a warning folded into the parsed bytes is bytes the predicate did not ask about",
    );
    assert.match(
      body,
      /END \{ exit !found \}' "\$TRUSTED_POLICY"/,
      "the verdict must run its predicate over the resolved file, the same one the " +
        "scans hand to gitleaks",
    );
    // 3. An inert policy is an ERROR at the verdict. An `::warning::` here would
    //    restore the blind green this job exists to prevent.
    assert.match(
      body,
      /echo "::error::The trusted gitleaks policy at \$POLICY_REF does not extend/,
      "an inert trusted policy must fail the job at the verdict, not warn",
    );
    assert.doesNotMatch(
      body,
      /::warning::No scan in this job ran/,
      "the old file-based verdict warned instead of failing",
    );

    // 4. All three scans carry the capability gate byte-identical, and the verdict
    //    carries it too but with a different inert arm -- it exits 1 where the scans
    //    skip. The workflow keeps the check in four places because failing inside the
    //    scans made every self-verification step after them unreachable; a drifted copy
    //    is exactly how that trade turns back into a blind green.
    //
    //    The scans are compared to EACH OTHER and the verdict is compared to neither:
    //    pinning all four to one text would fail on the one difference that is
    //    deliberate. What is asserted for the verdict is the property, not the shape --
    //    its arm ends the step.
    const blocks = capabilityBlocks(scan);
    assert.equal(
      blocks.length,
      4,
      `expected the capability predicate in all three scans plus the verdict, found ${blocks.length}`,
    );
    const skipping = blocks.filter((block) => !block.exits);
    const failing = blocks.filter((block) => block.exits);
    assert.equal(
      skipping.length,
      3,
      `expected the three scans to skip an inert policy, found ${skipping.length} that do`,
    );
    assert.equal(
      failing.length,
      1,
      `expected exactly one copy that ends the job on an inert policy (the verdict), found ${failing.length}`,
    );
    const [reference, ...rest] = skipping;
    for (const block of rest) {
      assert.equal(
        block.text,
        reference.text,
        `the three scans' copies of the capability gate have drifted apart (first differs at or after line ${reference.startLine})`,
      );
    }
    // And the verdict must not have quietly become a fourth skipper, which is the one
    // direction that would make a green run mean "unscanned".
    assert.equal(
      failing[0].text.includes("exit 1"),
      true,
      "the verdict's inert arm must end the job",
    );
  });

  it("the policy-resolution rationale describes skipping, not failing, inside the scan", () => {
    // In c4cd6517 the scans stopped failing the job and a closing step took over as
    // the verdict, because failing inside them made every self-verification step
    // after them unreachable. Four copies of the rationale still said the scan
    // "fails the job on purpose" and that an unusable policy "is refused", which is
    // the opposite of what the code does. Nothing executes a comment, so no gate
    // catches this; only a pinned assertion does.
    const scan = read(".github/workflows/secret-scan.yml");
    assert.doesNotMatch(
      scan,
      /fails the job on purpose|carry it is refused rather than assumed/,
      "the rationale still describes the scan as failing the job; it skips and the " +
        "closing step is what fails",
    );
    // ...and the corrected wording must be present, so the comment cannot simply be
    // deleted to satisfy the assertion above.
    assert.match(
      scan,
      /carry it is SKIPPED rather than assumed/,
      "the rationale must say the scan skips, naming the closing step as the verdict",
    );
  });

  it("secret-scan's policy-resolution note is placed where a reader will find it, and agrees with the code", () => {
    // The 38-line rationale for the resolver is the only record of why `-c` on
    // this repository's base policy detects nothing. It drifted twice: it sat
    // inside the comment run of the "Strip an untrusted baseline" step, so it read
    // as that step's documentation, and its last sentence still promised "the
    // warning below" for the inert case after the code had started emitting
    // `::error::` and `exit 1` for it. Both are comment-only faults, which is
    // exactly why they need pinning -- nothing else in the suite can see them,
    // and a mutation restoring the stale sentence leaves every test green.
    const scan = read(".github/workflows/secret-scan.yml");
    const noteAt = scan.indexOf("TRUSTED POLICY RESOLUTION");
    const checkoutAt = scan.indexOf("- name: Checkout trusted scanner policy");
    assert.ok(noteAt !== -1, "the policy-resolution note must exist");
    assert.ok(
      noteAt < checkoutAt,
      "the policy-resolution note must sit above the trusted-policy checkout, " +
        "not inside the comment run of a later step where it reads as that " +
        "step's documentation",
    );
    assert.doesNotMatch(
      scan,
      /honest state is the warning below/,
      "the note must not promise a warning for the inert case: the resolver " +
        "emits ::error:: and exits 1 for it, so there is no warning to promise",
    );
    // Matched against whitespace-normalised text. A mutation that reintroduced the
    // claim with different line wrapping left this green on the first attempt,
    // because the phrase was no longer contiguous in the file -- a mutation that
    // proved nothing while appearing to survive.
    const squashed = scan.replace(/\s+/g, " ");
    assert.doesNotMatch(
      squashed,
      /the only gate that can block it before it reaches main/,
      "the trigger comment must not promise a gate that cannot run: against a " +
        "base whose policy cannot extend the built-in detectors, no scan here " +
        "runs at all, so that claim is false exactly when it is most reassuring",
    );
  });

  it("secret-scan resolves its policy two ways, refuses an inert one, and never from the scanned tree", () => {
    // Two resolvers, not three. An intermediate version had a middle case -- pass
    // no `-c` at all when the trusted policy lacked the updater-key rule -- on the
    // reasoning that no config is stronger than an allowlist-only one. It is
    // stronger in the letter and weaker in the effect: origin/0.1.6 and
    // origin/main carry a gitleaks.toml with no `[[rules]]` and no `[extend]`, and
    // `-c` REPLACES the ruleset, so passing it runs an empty ruleset. That is a
    // green check which finds nothing, which is the condition no gate should be
    // able to reach silently. So the resolver is: absent or unreadable fails, an
    // inert one fails, and anything else is used as-is.
    const scan = read(".github/workflows/secret-scan.yml");
    const steps = extractSteps(scan);
    const scanSteps = steps.filter((step) => /^Scan /.test(step.name));
    assert.strictEqual(
      scanSteps.length,
      3,
      "expected the three enforcement scans",
    );

    // The trusted policy has to come from the base, never from the commit under
    // scan. On a push event `github.sha` IS the pushed commit, so pinning the
    // trusted checkout to it would make the word "trusted" mean nothing while
    // every other assertion in this test still passed.
    //
    // Matched inside the TRUSTED step's own body, not against the whole file. A
    // file-wide match is satisfied by any step that happens to carry the string --
    // proven by mutation: pointing the trusted checkout at `${{ github.sha }}` and
    // moving the base-sha `ref:` onto the untrusted "Checkout source commits for
    // scanning" step left the suite at 29/29. That is the one direction this
    // assertion exists to forbid, and the check was blind to it. `extractSteps`
    // already records each step's name, so the subject is addressable.
    const trustedCheckout = steps.find(
      (step) => step.name === "Checkout trusted scanner policy",
    );
    assert.ok(
      trustedCheckout,
      "secret-scan.yml needs a step named 'Checkout trusted scanner policy' for this " +
        "assertion to have a subject; if it was renamed, say so rather than deleting the check",
    );
    assert.match(
      trustedCheckout.inputs.join("\n"),
      /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| 'main' \}\}/,
      "the trusted policy checkout must be pinned to the base sha, or main on push",
    );

    for (const step of scanSteps) {
      const run = step.run.join("\n");

      // Case 1: trusted policy unreadable -> refuse. This is the part a contributor
      // can reach, and it must stay a refusal.
      // Fail closed on a policy this step cannot resolve by name. It used to be a
      // readability test on a path, which a later step could rewrite; the resolver is
      // what replaced it, and both of its own failure paths have to exit non-zero.
      assert.match(
        run,
        /if ! git -C \.\.\/trusted-scanner cat-file blob "\$POLICY_REF:gitleaks\.toml"[\s\S]*?exit 1/,
        `${step.name} must fail closed when the trusted policy cannot be resolved by ` +
          `name from the base commit`,
      );
      assert.match(
        run,
        /if \[ -s "\$POLICY_ERR" \]; then[\s\S]*?exit 1/,
        `${step.name} must fail closed when resolving the policy emitted diagnostics`,
      );

      // Case 2: trusted policy readable -> always use it. Matched as two
      // independent statements on purpose: an earlier version pinned them to
      // consecutive lines through one regex, so inserting a guard between them
      // failed the contract for a formatting reason. A gate that punishes
      // formatting is a gate people disable.
      assert.match(
        run,
        /CONFIG_ARGS=\(-c "\$TRUSTED_POLICY"\)/,
        `${step.name} must pass the trusted config`,
      );
      // The updater-key branch, asserted as a BLOCK.
      //
      // It used to be three separate string matches:
      //
      //     /if ! grep -q "tauri-minisign-updater-private-key"/   pins the rule id
      //     /::warning::/                                          matches any warning
      //     (the grep's file argument was not required at all)
      //
      // and each one was individually satisfiable by the wrong thing. Measured on the
      // committed file, 30/30 for each of these:
      //
      //     the grep reading the working tree's `gitleaks.toml` instead of
      //       "$TRUSTED_POLICY" -- so the check reads bytes the branch under review owns
      //     one scan's `::warning::` deleted -- the OTHER warning in the same step, the
      //       capability gate's at :347, satisfies a bare /::warning::/
      //
      // and the first one also pinned a rule id as the branch predicate, so the
      // coverage-correct shape -- gating on `useDefault` instead -- is REJECTED by this
      // contract. Measured: swapping the grep for a `useDefault` gate turns the suite red
      // with "must react to a trusted policy carrying no updater-key rule", which is the
      // assertion refusing the very thing its sibling five lines below demands.
      //
      // So: slice the branch, and require it to read the trusted policy by path and to
      // warn from inside itself. Both survive renaming the rule id and both survive
      // swapping `grep` for `awk`, which is the point -- the contract should pin what the
      // branch must DO, not which words it says it with.
      const updaterKeyBranch = (body) => {
        // Iterate every candidate rather than testing only the first: a scan step
        // carries several `if ! grep ...; then` lines, and stopping at one that is not
        // this branch returned null on a workflow where the branch is present.
        const opener = /^\s*if\s+!\s+(?:grep|awk)\b[^\n]*; then\s*$/gm;
        for (const open of body.matchAll(opener)) {
          // Selected by what it READS, not by a rule id. The id is
          // `tauri-minisign-updater-private-key`, which is not `updater-key` -- an
          // earlier guard matched on the shorter spelling, found nothing, and reported
          // the branch missing on a workflow that carries it in all three scans.
          if (!/\$TRUSTED_POLICY/.test(open[0])) continue;
          const rest = body.slice(open.index + open[0].length);
          const close = /^\s*fi\s*$/m.exec(rest);
          return {
            head: open[0],
            inner: close ? rest.slice(0, close.index) : rest,
          };
        }
        return null;
      };
      const branch = updaterKeyBranch(run);
      assert.ok(
        branch,
        `${step.name} must react to a trusted policy carrying no updater-key rule`,
      );
      assert.match(
        branch.head,
        /"\$TRUSTED_POLICY"/,
        `${step.name} must read the trusted policy BY PATH when deciding whether the ` +
          "updater-key detector is present; reading the working tree's copy would let " +
          "the branch under review supply the answer",
      );
      assert.match(
        branch.inner,
        /::warning::/,
        `${step.name} must warn from INSIDE the branch that decides whether the ` +
          "updater-key detector is active, not merely somewhere in the step -- this " +
          "step carries another warning, the capability gate's, which says nothing " +
          "about the updater-key rule",
      );
      assert.doesNotMatch(
        run,
        /CONFIG_ARGS=\(\)/,
        `${step.name} must never leave the gitleaks config unset`,
      );

      // The invariant the four assertions above do NOT establish, and the one
      // that actually matters: that the config handed to `gitleaks detect`
      // resolves to at least one active rule. Every assertion above holds just as
      // well for a policy carrying zero rules, which is precisely what 0.1.6 and
      // main carry -- so without these the suite is green against a scan that
      // cannot detect anything, and the fixture at "Prove a built-in detector is
      // active" does not help either because it deliberately runs with no config.
      //
      // One property, not two. The previous version of this file asserted two,
      // and that is where the error was: `[[rules]]` proves the ruleset is
      // NON-EMPTY, which is not the same as proving the scan has any coverage.
      // `-c` replaces the built-in rules, so a policy carrying one narrow
      // `[[rules]]` table and no `[extend]` scans the whole range with that
      // single regex and roughly 180 detectors switched off -- the same blind
      // green as an empty policy, only narrower, passing a check whose error
      // message talked about coverage. So a `[[rules]]` table must NOT be
      // accepted as proof of anything here.
      //
      // What remains is one positive proof, scoped tightly: `useDefault = true`
      // inside an `[extend]` body terminated by the next table header. The
      // scoping is load-bearing rather than decorative, because a bare search for
      // `useDefault = true` is satisfied by the word appearing inside a
      // `description` string or inside `[allowlist]`, where Gitleaks ignores it.
      const awkProgramsIn = (body) =>
        [...body.matchAll(/awk '([\s\S]*?)'/g)].map((match) => match[1]);
      assert.ok(
        !awkProgramsIn(run).some((program) => /\[\[rules\]\]/.test(program)),
        `${step.name} must not treat a [[rules]] table as proof of coverage: -c ` +
          "replaces the built-in detectors rather than adding to them",
      );
      // The scoping is asserted as a PROPERTY: some identifier is raised on the
      // `[extend]` line, and the SAME identifier gates the `useDefault` match. It used to
      // be `run.includes("in_extend && /^[[:space:]]*useDefault")`, which pins the
      // variable's name -- measured, renaming `in_extend` to `ext` in all four copies is
      // a pure rename with zero behaviour change and turned the suite red on it. The
      // file's own comment at :715-719 says the principle these broke: "A gate that
      // punishes formatting is a gate people disable."
      const programs = awkProgramsIn(run);
      assert.ok(
        programs.length > 0,
        `${step.name} must carry the [extend]/useDefault capability predicate`,
      );
      for (const program of programs) {
        // The literal is written `\[extend\]` -- it sits inside an awk regex literal, so the
        // brackets are escaped in the source. The backslashes are optional here so the
        // pattern matches the escaped and unescaped spellings alike; a first version
        // without them found no flag at all on a program that has one.
        const raised =
          /\\?\[\s*extend\s*\\?\][^\n]*?\{\s*([A-Za-z_]\w*)\s*=\s*1\s*;\s*next/.exec(
            program,
          );
        assert.ok(
          raised,
          `${step.name}'s capability predicate must raise a flag on an [extend] table, ` +
            "so the useDefault match below it can be scoped to that table's body",
        );
        const gated = new RegExp(`\\b${raised[1]}\\b[^\\n]*useDefault`).test(
          program,
        );
        assert.ok(
          gated,
          `${step.name}'s capability predicate must require useDefault behind the same ` +
            `flag it raises on [extend] (\\b${raised[1]}\\b); a bare search for useDefault ` +
            "is satisfied by the word appearing inside a description or an [allowlist], " +
            "where gitleaks ignores it",
        );
      }
      // An inert policy must SKIP this scan -- not fail here.
      //
      // Failing here is what the previous version did, and it was worse than it
      // looked: the scans are steps 6-8 and the six steps after them carry no
      // `if:`, so an `exit 1` made this job never run a single one of its own
      // self-verification steps -- the updater-key fixture, the built-in detector
      // fixture, both config-guard steps and the history-scan integration test all
      // became unreachable against this repository's own base. The job reported a
      // policy problem while proving nothing about itself.
      //
      // It used to skip by writing a sentinel file for the closing step to find.
      // That is gone: the file was reachable by steps 12-14, which run the
      // pull request's own `scripts/ci/*.mjs` as this job's uid, so the branch
      // under review could both hide a skipped scan and fabricate one. The scan
      // now records nothing and simply says so; the closing verdict re-derives the
      // answer from the trusted checkout. See "the verdict re-derives policy
      // capability itself" for the full argument.
      assert.match(
        run,
        /if \[ "\$active" -ne 1 \]; then[\s\S]*?echo "::warning::Trusted gitleaks policy at/,
        `${step.name} must warn and skip on an inert policy instead of failing`,
      );
      assert.doesNotMatch(
        run,
        /\$INERT_SENTINEL/,
        `${step.name} must not write a sentinel file; the pull request can delete or ` +
          `forge any file this job's steps can write`,
      );
      // Bounded by a line-anchored `fi`, not by `indexOf("fi")`. That version matched
      // the word "first" inside the comment above the arm, so the slice stopped inside a
      // comment and never reached the `exit` at all: replacing `exit 0` with `exit 1`
      // left this assertion green. Found by mutating the workflow, which is the only
      // way an assertion this shape fails -- it looks like it is checking something.
      const inertArm = run.slice(run.indexOf('if [ "$active" -ne 1 ]; then'));
      const armEnd = /^\s*fi\s*$/m.exec(inertArm);
      assert.ok(armEnd, `${step.name}: unterminated inert arm`);
      assert.doesNotMatch(
        inertArm.slice(0, armEnd.index),
        /exit 1/,
        `${step.name} must not exit non-zero on the inert path, or the ` +
          `self-verification steps after it never run`,
      );
      assert.match(
        inertArm.slice(0, armEnd.index),
        /exit 0/,
        `${step.name} must exit 0 on the inert path, so the job's own ` +
          `self-verification steps after it still run`,
      );

      // The verdict belongs at the end of the job, where `always()` reaches it.
      const gate = scan.indexOf(
        "- name: Require a secret-scan policy that can actually detect secrets",
      );
      assert.ok(gate !== -1, "the closing policy gate must exist");
      assert.match(
        scan.slice(gate),
        /if: always\(\)/,
        "the closing gate must run under always(), or a failure above hides it",
      );
      // The gate must pass once the base policy is fixed, and fail while it is not,
      // from a check it makes itself. Both arms are asserted positively, because the
      // inert arm used to be "a branch that has to be added later" -- it was reached
      // only by a file existing, and deleting that file deleted the failure.
      // The pass arm, asserted as a STATEMENT rather than as a search.
      //
      // This used to be a search with a tail:
      //     /echo "The trusted ... detectors[\s\S]*?$/m
      // With `m`, `$` is satisfied at the first line end after the literal, and `[^]` is
      // non-greedy, so the whole thing reduces to "the echo appears somewhere after the
      // gate". It looks like it pins the shape of the pass arm and pins nothing of the
      // kind. Measured: adding `exit 1` immediately after that echo -- so the gate now
      // fails on a capable policy, i.e. the job is red forever once the base is fixed --
      // left the suite at 30/30. The inert arm's exit is asserted two lines below; the
      // pass arm's was not asserted anywhere.
      //
      // So: slice from the pass echo to the end of the STEP, drop comments, and require
      // that what remains carries no `exit`. A gate that cannot exit is one that passes.
      const gateTail = scan.slice(gate);
      const passEcho = gateTail.indexOf(
        'echo "The trusted gitleaks policy at $POLICY_REF extends',
      );
      assert.notEqual(
        passEcho,
        -1,
        "the closing gate must pass when the trusted policy extends the built-in " +
          "detectors, so it is not unconditionally red once the base policy is fixed",
      );
      // The step ends at the next `- name:` at the steps indent, or at end of text.
      const afterPass = gateTail.slice(passEcho);
      const nextStep = afterPass.search(/^\s{6}- name:/m);
      const passArm =
        nextStep === -1 ? afterPass : afterPass.slice(0, nextStep);
      const passArmCode = passArm
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
        .join("\n");
      assert.doesNotMatch(
        passArmCode,
        /^\s*exit\b/m,
        "the closing gate's PASS arm must not exit: an `exit` there makes this job red on " +
          "every run once the base policy is fixed, which is the opposite of passing",
      );
      // And it must actually say so, so the pass is not a silent one.
      assert.match(
        passArm,
        /so every scan in this job ran against it\./,
        "the closing gate's pass arm must state that the scans ran against the trusted " +
          "policy, which is the thing a green run of this job means",
      );
      assert.match(
        scan.slice(gate),
        /if \[ "\$active" -ne 1 \]; then[\s\S]*?exit 1/,
        "the closing gate must exit 1 on an inert trusted policy, decided by its " +
          "own check of the trusted checkout rather than by a file a step left behind",
      );
      assert.match(
        scan.slice(gate),
        /Do not read a green run of this job as evidence that no credential was added/,
        "the closing gate must say that a green run is not evidence of a clean " +
          "range, which is the property that was silently false",
      );

      // The message must name the ref the trusted checkout actually used. Asserted
      // by deriving the expected expression from the checkout itself, so the two
      // cannot drift, and separately barred from `github.sha`, which on a push
      // event is the pushed commit -- so the one event where an operator is told
      // to go look at the base was the one event naming a commit whose policy was
      // never read.
      assert.match(
        run,
        /POLICY_REF="\$\{\{ github\.event\.pull_request\.base\.sha \|\| 'main' \}\}"/,
        `${step.name} must name the trusted policy's ref, which is the base sha or main`,
      );

      // Case 3: never the scanned checkout. An enforcement step may not so much as
      // mention it, which is a stronger bar than "does not prefer it".
      assert.doesNotMatch(
        run,
        /scan-target\/gitleaks\.toml/,
        `${step.name} must not reference the pull request's own gitleaks.toml`,
      );
      assert.doesNotMatch(
        run,
        /CONFIG_FILE=/,
        `${step.name} must resolve its config through CONFIG_ARGS, not a bare CONFIG_FILE`,
      );
      assert.match(
        run,
        /\$\{CONFIG_ARGS\[@\]\+"\$\{CONFIG_ARGS\[@\]\}"\}/,
        `${step.name} must pass -c conditionally, so an absent trusted config is not an unset variable`,
      );
      assert.match(
        run,
        /--gitleaks-ignore-path "\$BASELINE_FILE"/,
        `${step.name} must still name its baseline explicitly`,
      );
    }

    // The fixture steps are the one legitimate reader of the branch's own policy,
    // because they prove the detector this PR adds actually fires -- a rule base
    // cannot have yet. That exemption is scoped by step name so it cannot spread.
    const fixtureUsers = steps.filter((step) =>
      step.run.join("\n").includes('CONFIG_FILE="scan-target/gitleaks.toml"'),
    );
    assert.deepStrictEqual(
      fixtureUsers.map((step) => step.name),
      ["Prove a Base64-only updater key is detected"],
      "only the updater-key self-test may read the pull request's own gitleaks.toml",
    );

    // And no enforcement step may fall back to a bare `CONFIG_FILE=gitleaks.toml`,
    // which resolves inside scan-target and is the same hole spelled differently.
    assert.doesNotMatch(
      scan,
      /CONFIG_FILE="gitleaks\.toml"/,
      "a bare CONFIG_FILE=gitleaks.toml resolves inside the scanned checkout",
    );
  });

  it("secret-scan reads its Node pin from the trusted checkout too", () => {
    // `node-version-file: scan-target/.nvmrc` does resolve -- scan-target is a
    // full checkout, and `.nvmrc` is tracked at its root, so a reviewer's claim
    // that the step fails outright was wrong. The reason to change it is the
    // same one as above: the version the guard tests run under was then chosen by
    // the pull request, and a fork PR could move the whole verification off the
    // pinned runtime.
    const scan = read(".github/workflows/secret-scan.yml");
    const pin = scan.match(/node-version-file:\s*(\S+)/);
    assert.ok(pin !== null, "secret-scan.yml must pin node-version-file");
    assert.strictEqual(
      pin[1],
      "trusted-scanner/.nvmrc",
      "the Node pin must come from the trusted checkout, not the scanned one",
    );
    assert.doesNotMatch(
      scan,
      /node-version-file:\s*scan-target\//,
      "no step may take its Node version from the scanned checkout",
    );
  });

  it("secret-scan never lets the scanned checkout supply its own baseline", () => {
    // Measured against gitleaks 8.18.0 rather than assumed: `detect` auto-loads
    // `<source>/.gitleaksignore` from the tree it scans, and
    // `--gitleaks-ignore-path` only ADDS a baseline -- it does not suppress that
    // auto-load. With the untrusted file present, a scan whose trusted baseline
    // was empty still reported "no leaks found"; the finding only reappeared
    // after the untrusted file was deleted from the tree. So the file has to
    // leave the checkout: pinning the flag alone would have left the hole open
    // while looking fixed, which is the failure mode this pins against.
    const scan = read(".github/workflows/secret-scan.yml");
    const steps = extractSteps(scan);
    const names = steps.map((step) => step.name);
    const stripAt = names.findIndex((name) =>
      /Strip an untrusted baseline/.test(name),
    );
    assert.notStrictEqual(
      stripAt,
      -1,
      "secret-scan.yml must strip an untrusted .gitleaksignore out of the scanned checkout",
    );

    const scanSteps = steps.filter((step) => /^Scan /.test(step.name));
    assert.deepStrictEqual(
      scanSteps.map((step) => step.name),
      [
        "Scan PR commit range for secrets",
        "Scan pushed commit range for secrets",
        "Scan working tree for committed updater keys",
      ],
      "expected the three gitleaks scans to still exist under their current names",
    );
    for (const step of scanSteps) {
      assert.ok(
        names.indexOf(step.name) > stripAt,
        `${step.name} runs before the strip step, so it scans a tree that still carries the untrusted baseline`,
      );
      assert.match(
        step.run.join("\n"),
        /--gitleaks-ignore-path/,
        `${step.name} must name the trusted baseline explicitly rather than rely on an unstated default`,
      );
    }

    const strip = steps[stripAt];
    assert.match(
      strip.run.join("\n"),
      /rm -f scan-target\/\.gitleaksignore/,
      "the strip step has to remove the file, not merely warn about it",
    );
    // The comparison itself, not just the env plumbing. Asserting that HEAD_REPO
    // is passed in is satisfied by a step that receives it and never reads it,
    // and stripping unconditionally would silently drop this repo's own
    // baseline -- the fork PRs are the ones that need it gone.
    assert.match(
      strip.run.join("\n"),
      /if \[ "\$HEAD_REPO" = "\$BASE_REPO" \]; then[\s\S]*?exit 0/,
      "the strip step must skip same-repo branches before removing the baseline",
    );
    // Fork-only, because the legitimate and hostile cases are the same
    // mechanism: this repo's own baseline holds a fingerprint for a test
    // fixture, and base carries no baseline at all.
    assert.match(
      scan,
      /github\.event\.pull_request\.head\.repo\.full_name/,
      "the strip step must distinguish a fork head from a same-repo branch",
    );
    assert.match(
      scan,
      /if:\s*github\.event_name == 'pull_request'\s*\n\s*env:\s*\n\s*HEAD_REPO:/,
      "the strip step must be gated on pull_request and compare HEAD_REPO",
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
