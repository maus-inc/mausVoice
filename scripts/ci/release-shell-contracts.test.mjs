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
  /** @type {{ name: string, shell: string | null, shells: string[], run: string[],
   *          if: string | null, workingDirectory: string | null }[]} */
  const steps = [];
  let current = null;
  let inRun = false;
  let runIndent = 0;

  for (const line of lines) {
    const stepMatch = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (stepMatch) {
      if (current) steps.push(current);
      current = {
        name: stepMatch[1],
        shell: null,
        shells: [],
        run: [],
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
    // Unconditional, and that is load-bearing rather than sloppy. A line inside a `run: |`
    // body cannot reach here: the block above `continue`s on it when it is blank or more
    // indented than the `run:` key, and clears `inRun` on a dedent. So this guard used to
    // read `if (!inRun)`, which DeepScan was right about -- it is always true, because
    // arriving here already means `inRun` is false.
    //
    // The property it was written to protect is real and is the `continue` above, not the
    // condition. Reinstating the guard would add a check that cannot fail, which reads as
    // protection and is not.
    const ifMatch = line.match(/^\s*if:\s*(.+?)\s*$/);
    if (ifMatch) {
      current.if = ifMatch[1];
      continue;
    }
    const wdMatch = line.match(/^\s*working-directory:\s*(.+?)\s*$/);
    if (wdMatch) {
      current.workingDirectory = wdMatch[1];
      continue;
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
  // The capability check, as it appears in the three scans and in the verdict.
  //
  // Compared as the awk PROGRAM, not as the whole block. The three scans feed it a
  // path and the verdict feeds it a blob, so their `if` lines differ by construction:
  // `if awk '...' "$TRUSTED_POLICY"` against `if printf '%s' "$POLICY_BLOB" | awk
  // '...'`. What must not drift is the question being asked, which is the program.
  const capabilityProgram = (text) => {
    const programs = [];
    const marker = "awk '";
    let at = text.indexOf(marker);
    while (at !== -1) {
      const start = at + marker.length;
      const end = text.indexOf("'", start);
      if (end === -1) break;
      programs.push(text.slice(start, end));
      at = text.indexOf(marker, end);
    }
    return programs;
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
    assert.equal(outer.if, null, "a key-shaped line in the body is not the step's `if`");
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

    // Positive: there ARE such steps, so emptying the list cannot make this pass.
    const branchCode = steps.filter((step) =>
      /(?:^|[\s;&|(])(?:node|npx|bun|deno)\s[^\n]*scripts\/ci\//.test(
        step.run.join("\n"),
      ),
    );
    assert.equal(
      branchCode.length,
      3,
      "expected the three config-guard/history-scan steps to resolve scripts/ci/ out of " +
        "the scanned checkout; a different count means this assertion has lost its subject",
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

    // 4. All four copies of the predicate are byte-identical. The workflow keeps the
    //    check in four places because failing inside the scans made every
    //    self-verification step after them unreachable; a drifted copy is exactly how
    //    that trade turns back into a blind green.
    const programs = capabilityProgram(scan);
    assert.equal(
      programs.length,
      4,
      `expected the capability predicate in all three scans plus the verdict, found ${programs.length}`,
    );
    const [reference, ...rest] = programs;
    for (const program of rest) {
      assert.equal(
        program,
        reference,
        "the four copies of the capability predicate have drifted apart",
      );
    }
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
    assert.match(
      scan,
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
      assert.match(
        run,
        /if ! grep -q "tauri-minisign-updater-private-key"/,
        `${step.name} must react to a trusted policy carrying no updater-key rule`,
      );
      assert.match(
        run,
        /::warning::/,
        `${step.name} must surface that as a warning rather than acting on it`,
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
      assert.ok(
        !run.includes("grep -qE '^[[:space:]]*\\[\\[rules\\]\\]'"),
        `${step.name} must not treat a [[rules]] table as proof of coverage: -c ` +
          "replaces the built-in detectors rather than adding to them",
      );
      assert.ok(
        run.includes("in_extend && /^[[:space:]]*useDefault"),
        `${step.name} must require useDefault = true inside an [extend] body, not anywhere in the file`,
      );
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
      assert.match(
        scan.slice(gate),
        /echo "The trusted gitleaks policy at \$POLICY_REF extends gitleaks' built-in detectors[\s\S]*?$/m,
        "the closing gate must pass when the trusted policy extends the built-in " +
          "detectors, so it is not unconditionally red once the base policy is fixed",
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
