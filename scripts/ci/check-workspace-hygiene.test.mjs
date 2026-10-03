import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The subset of glob syntax these patterns use: `**` for any path depth and `*`
// for anything but a separator. A full matcher is not worth a dependency for two
// patterns, and a test that silently mis-matches would be worse than no test.
const globToRegExp = (pattern) => {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
};

// Every `*.test.mjs` the workflow text would actually execute, as the
// repository-relative path a workflow's own `paths:` filter is written in.
//
// The directory is carried, not just the file name, because the two checks below
// compare against paths and a bare name cannot be compared to either:
// `node --test scripts/run-tauri-dev.test.mjs` and
// `node --test scripts/ci/run-tauri-dev.test.mjs` are different files sharing a
// name. `apps/desktop`'s own `test:unit` runs the first of those, so dropping
// the directory made a correct workflow look like it was missing a
// `scripts/ci/` entry that cannot exist.
//
// Matched on a command, not on a substring: a suite named in a `paths:` trigger
// filter, or in prose, is not a suite anything executes, and a check that
// accepted those would report a guard as wired while it is dead. So a comment
// line is skipped outright.
//
// What is left is the whole remainder of the command line, not just the token
// after the flag. Anchoring on that one token held only of the single-file,
// no-flag spelling, and three ordinary shapes broke it:
//
//   node --test --test-reporter=spec scripts/ci/a.test.mjs  -> matched nothing
//   node --test scripts/ci/a.test.mjs scripts/ci/b.test.mjs -> matched only `a`
//   node --test scripts/ci/*.test.mjs                       -> matched nothing
//
// None of those is in this repository today, so nothing fails yet. Each of them
// would turn a suite CI runs every day into an `unwired` entry, and the failure
// message tells the reader those suites "are never run, so they assert nothing"
// -- which sends them looking for a workflow step that is sitting right there.
//
// `repoRoot`, not `scripts/ci`, because a path in a workflow is written from the
// repository root: resolving `scripts/ci/` against the `scripts/ci` directory
// looks for `scripts/ci/scripts/ci`, which is how the first version of this
// expanded a glob to nothing and then failed on its own guard.
function executedSuites(workflowsText, repoRoot) {
  const executed = new Set();
  for (const line of workflowsText.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const command = /node\s+--test\b(.*)$/.exec(line);
    if (!command) continue;
    for (const raw of command[1].split(/\s+/)) {
      const token = raw.replace(/[;"'`]+$/, "").replace(/^["'`]/, "");
      // The suite name is the token's last path segment. Matching the tail with
      // `[\w.-]+` instead would read `scripts/ci/*.test.mjs` as no match at all,
      // because neither `/` nor `*` is in that class -- which is the one shape
      // this was extended to handle.
      const directory = token.slice(0, token.lastIndexOf("/") + 1);
      const name = token.slice(token.lastIndexOf("/") + 1);
      if (!name.endsWith(".test.mjs")) continue;
      if (!name.includes("*")) {
        executed.add(`${directory}${name}`);
        continue;
      }
      // A glob stands for the suites it names, so expand it rather than
      // recording a literal `*` no suite is called.
      const target = resolve(repoRoot, directory);
      if (!existsSync(target)) continue;
      const prefix = name.slice(0, name.indexOf("*"));
      const suffix = name.slice(name.lastIndexOf("*") + 1);
      for (const file of readdirSync(target)) {
        if (file.startsWith(prefix) && file.endsWith(suffix)) {
          executed.add(`${directory}${file}`);
        }
      }
    }
  }
  return executed;
}

// A `paths:` entry that names a whole directory, so it covers every suite under
// it and is not an omission. No `g` flag: `.test` on a global regex carries
// `lastIndex` between calls, and this is called once per workflow.
// The `paths:` entries of a workflow, as the patterns they are written in.
// (This replaces a fixed list of "a whole directory" patterns, which had to be
// kept in step with the matcher below by hand and drifted: one of the four
// exempted the whole check for a directory that covered no suite.)
//
// A `paths:` filter is a glob list, so an entry is matched as one rather than
// compared to a suite path as a string. Both of the halves of that matter, and
// each of them was a way this check reported a correct workflow:
//
//   * `scripts/ci/**` covers `scripts/ci/foo.test.mjs`, and reading entries as
//     literals called every suite in the tree an omission.
//   * `.github/**` covers no path under `scripts/ci` at all, and treating any one
//     entry as an exemption switched the check off for the whole file. A
//     workflow carrying it and running a suite from `scripts/ci` had a real
//     omission reported as none.
//
// So the two decisions collapse into one: glob the entry against the suite path
// and let the matcher decide. There is no separate list of "exempt" patterns to
// keep consistent with the matcher, which is the class of bug this file exists
// to catch.
function pathsEntries(text) {
  const lines = text.split("\n");
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*paths:\s*$/.test(lines[index])) continue;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan];
      // A list item of this block, or a deeper one -- `paths:` at four spaces
      // puts its items at six, and a workflow is free to indent further.
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        entries.push(item[1].replace(/^["']|["']$/g, ""));
        continue;
      }
      // A line at or left of the `paths:` key, or a non-item sibling of one,
      // ends the block. Blanks and comments sit inside blocks and do not.
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      if (/^\s*-\s/.test(line) || /^\s*\S/.test(line)) break;
    }
  }
  return entries;
}

// The suites one workflow runs that its own `paths:` filter does not name.
//
// Split out of the loop that uses it so a synthetic workflow can be fed to it.
// The decision is the entire point of the guard, and while it was inline the
// only thing that could exercise it was the nine workflows this repository
// happens to have -- which is how it came to demand a `scripts/ci/` entry for a
// suite run from `apps/desktop/scripts`.
//
// File-scoped on purpose, not per `paths:` block. GitHub runs a workflow "if at
// least one path matches a pattern in the `paths` filter", so the blocks in a
// workflow are a union rather than an intersection: one of them naming
// `scripts/**` already covers a second, narrower one. `format-and-i18n.yml` and
// `test-package-rust-transcription.yml` both carry a `push` and a `pull_request`
// list, and a per-block rule would fail them for no reason a reader could act on.
function missingFromTriggerFilter(text, repoRoot) {
  // Only a workflow with a `paths:` filter can be missing an entry. One that
  // triggers on every push has nothing to keep in sync.
  if (!/^\s*paths:\s*$/m.test(text)) return [];
  const executed = executedSuites(text, repoRoot);
  if (executed.size === 0) return [];
  // One matcher for the whole filter, because the question is per suite and not
  // per entry: a suite is missing when no entry in any block names it.
  const matchers = pathsEntries(text).map((entry) => globToRegExp(entry));
  return [...executed].filter(
    (path) => !matchers.some((matcher) => matcher.test(path)),
  );
}

describe("workspace hygiene contracts", () => {
  it("rejects captured session transcripts and stray debug dumps", () => {
    assert.ok(
      !existsSync(resolve(repoRoot, "fully read this.txt.txt")),
      "captured session transcript 'fully read this.txt.txt' must not exist",
    );

    const trackedFiles = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    const forbiddenPatterns = [
      /\.txt\.txt$/,
      /session.*transcript.*\.txt$/i,
      /debug.*prompt.*dump/i,
    ];

    for (const file of trackedFiles) {
      for (const pattern of forbiddenPatterns) {
        assert.ok(
          !pattern.test(file),
          `Tracked file '${file}' violates workspace hygiene (${pattern})`,
        );
      }
    }
  });

  it("ensures git diff --check reports no whitespace or CRLF errors", () => {
    try {
      execSync("git diff --check HEAD", {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch (err) {
      // If there are working directory diffs, test against tracked files only
      const trackedStatus = execSync("git diff --check", {
        cwd: repoRoot,
        encoding: "utf8",
      });
      assert.doesNotMatch(
        trackedStatus,
        /trailing whitespace|CRLF/,
        "working tree diff must not introduce CRLF or trailing whitespace errors",
      );
    }
  });

  it("every DeepSource exclusion still excludes something", () => {
    // A path pattern that matches nothing is a gate that quietly stopped
    // analysing something, which is the one failure mode a config file cannot
    // report: the run still succeeds and the reason for the exclusion is gone.
    // Read rather than parsed, deliberately. The job that runs this suite is the
    // one that never installs pnpm, so a TOML library would have to be vendored
    // to be usable here at all -- and twenty lines of config does not need one.
    const config = readFileSync(resolve(repoRoot, ".deepsource.toml"), "utf8");
    const tracked = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    const overrides = config.split(/^\[\[overrides\]\]$/m).slice(1);
    assert.ok(
      overrides.length > 0,
      ".deepsource.toml must state which paths the analyzers skip",
    );

    for (const block of overrides) {
      // Joined before matching, so a `paths = [` array spread over several lines
      // is read rather than reported as an exclusion that lists nothing.
      const joined = block.replace(/\s+/g, " ");
      const paths = [...joined.matchAll(/paths\s*=\s*\[(.*?)\]/g)]
        .flatMap((matched) => matched[1].split(","))
        .map((path) => path.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      assert.ok(
        paths.length > 0,
        "an [[overrides]] block must list the paths it skips, as a `paths = [...]` " +
          "array (one line or several)",
      );
      const matchers = paths.map((pattern) => globToRegExp(pattern));
      const hit = tracked.filter((file) =>
        matchers.some((shape) => shape.test(file)),
      );
      assert.ok(
        hit.length > 0,
        `no tracked file matches ${paths.join(", ")}; the exclusion has rotted`,
      );
      assert.match(
        block,
        /enabled\s*=\s*false/,
        `${paths.join(", ")} must disable an analyzer rather than narrow it, ` +
          "or the exclusion does not do what its comment says",
      );
    }
  });

  // The failure this suite itself fell into: a guard that no job runs is
  // documentation. This checks the whole directory, so the next suite added
  // here cannot quietly be one.
  it("every guard in scripts/ci is executed by some workflow", () => {
    const workflows = readdirSync(resolve(repoRoot, ".github/workflows"))
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) =>
        readFileSync(resolve(repoRoot, ".github/workflows", file), "utf8"),
      )
      .join("\n");
    const suites = readdirSync(resolve(repoRoot, "scripts/ci")).filter((file) =>
      file.endsWith(".test.mjs"),
    );

    assert.ok(suites.length > 0, "scripts/ci must hold at least one guard");
    const executed = executedSuites(workflows, repoRoot);

    // A suite can also be reached by being imported: `pr28-contracts` pulls in
    // `pr37-contracts` and both run from one `node --test`. Following the
    // imports keeps the check from calling a suite that genuinely executes
    // every day dead, which would be the fastest way to teach everyone to
    // ignore it.
    const imported = new Map();
    for (const suite of readdirSync(resolve(repoRoot, "scripts/ci"))) {
      if (!suite.endsWith(".mjs")) continue;
      const source = readFileSync(
        resolve(repoRoot, "scripts/ci", suite),
        "utf8",
      );
      imported.set(
        suite,
        [...source.matchAll(/(?:from|import\()\s*"\.\/([\w.-]+\.mjs)"/g)].map(
          (matched) => matched[1],
        ),
      );
    }
    const reached = new Set(executed);
    for (let grew = true; grew;) {
      grew = false;
      for (const path of [...reached]) {
        // An import is relative, so what it names sits beside its importer, and
        // the suite it reaches keeps the importer's directory.
        const directory = path.slice(0, path.lastIndexOf("/") + 1);
        const suite = path.slice(directory.length);
        for (const next of imported.get(suite) ?? []) {
          const nextPath = `${directory}${next}`;
          if (!reached.has(nextPath)) {
            reached.add(nextPath);
            grew = true;
          }
        }
      }
    }

    const unwired = suites.filter(
      (suite) => !reached.has(`scripts/ci/${suite}`),
    );
    assert.deepStrictEqual(
      unwired,
      [],
      `these guards are never run, so they assert nothing: ${unwired.join(", ")}`,
    );
  });

  // The half of the same failure that the check above cannot see: a suite can
  // be run by a workflow and still not run for the edit that breaks it.
  //
  // `paths:` is a trigger filter, and it is workflow-level, so it cannot be
  // narrowed to the jobs that do not need it -- which is why the fix for a
  // missing entry costs a heavy Rust job on a `.mjs` comment. Worth it anyway:
  // `test-desktop-unit.yml` runs ten `scripts/ci` suites and was missing six of
  // them (four were already named), so a change to any of the other six skipped
  // the workflow that executes it.
  it("a suite a workflow runs is in that workflow's trigger filter", () => {
    const dir = resolve(repoRoot, ".github/workflows");
    const offenders = [];
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(resolve(dir, file), "utf8");
      const missing = missingFromTriggerFilter(text, repoRoot);
      if (missing.length > 0) offenders.push(`${file}: ${missing.join(", ")}`);
    }
    assert.deepStrictEqual(
      offenders,
      [],
      "a workflow runs these suites but its `paths:` filter does not name them, " +
        "so editing one does not start the job that runs it",
    );
  });
});

// The scanner above is the only thing standing between a guard and being
// documentation, so a shape of `run:` line it cannot read is a shape that turns
// a live guard into a reported dead one. These are the spellings a workflow is
// written in the moment someone tidies a line.
describe("the workflow scan finds every way a suite is executed", () => {
  // Repo root, because that is the directory a workflow's own paths are
  // relative to.
  const scanRoot = repoRoot;

  it("sees a suite behind a reporter flag", () => {
    const text = [
      "      - run: node --test --test-reporter=spec scripts/ci/dev-surface-contracts.test.mjs",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      [...executedSuites(text, scanRoot)],
      ["scripts/ci/dev-surface-contracts.test.mjs"],
      "a flag between `node --test` and the path is not a reason to miss the suite",
    );
  });

  it("sees every suite when one command runs two", () => {
    const text = [
      "          node --test scripts/ci/release-notes.test.mjs scripts/ci/validate-release-inputs.test.mjs",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      [...executedSuites(text, scanRoot)].sort(),
      [
        "scripts/ci/release-notes.test.mjs",
        "scripts/ci/validate-release-inputs.test.mjs",
      ],
      "a second suite on the same command is still a suite something executes",
    );
  });

  it("expands a glob rather than recording it", () => {
    const text = ["      - run: node --test scripts/ci/*.test.mjs", ""].join("\n");
    const found = executedSuites(text, scanRoot);
    assert.ok(
      found.size > 5,
      "a glob stands for every suite in the directory, not for one literal `*`",
    );
    assert.ok(
      found.has("scripts/ci/windows-tauri-imports.test.mjs") &&
        found.has("scripts/ci/check-workspace-hygiene.test.mjs"),
      `a glob must resolve to the suites it names, got ${[...found].length} entries`,
    );
    assert.ok(
      ![...found].some((name) => name.includes("*")),
      "a glob must not be recorded as a suite name",
    );
  });

  it("still ignores a suite that is only named, never run", () => {
    // The property the narrower scan was written for, and the reason this one
    // is not simply a substring match.
    const text = [
      '      - "scripts/ci/dev-surface-contracts.test.mjs"',
      "      # this job runs node --test and nothing else",
      "      # node --test scripts/ci/release-notes.test.mjs",
      "      - run: node --test scripts/ci/windows-tauri-imports.test.mjs",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      [...executedSuites(text, scanRoot)],
      ["scripts/ci/windows-tauri-imports.test.mjs"],
      "a `paths:` entry or a mention in prose is not a suite anything executes",
    );
  });

  it("keeps the directory a suite is run from", () => {
    // The trigger-filter check compares an executed path against a `paths:`
    // entry, and a bare file name cannot be compared to either. These two files
    // share a name and nothing else, and the second one is what `apps/desktop`'s
    // own `test:unit` script runs.
    const text = [
      "      - run: node --test scripts/run-tauri-dev.test.mjs",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      [...executedSuites(text, scanRoot)],
      ["scripts/run-tauri-dev.test.mjs"],
      "the directory is part of which suite this is",
    );
  });
});

// The trigger filter is the one guard above whose decision was never exercised
// by anything but the workflows this repository happens to have, which is how it
// came to reject a correct one. These feed it synthetic workflows.
describe("the trigger filter check compares executed paths to filter entries", () => {
  const scanRoot = repoRoot;

  const workflow = (paths, command) =>
    [
      "on:",
      "  push:",
      "    paths:",
      ...paths.map((path) => `      - "${path}"`),
      "jobs:",
      "  unit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      `      - run: ${command}`,
      "",
    ].join("\n");

  it("does not demand a scripts/ci entry for a suite run from elsewhere", () => {
    // The false positive this replaces: the required entry was hardcoded to
    // `scripts/ci/`, so this workflow -- which names the path it actually runs
    // -- was reported as missing `scripts/ci/run-tauri-dev.test.mjs`, an entry
    // that cannot exist and that adding would not start the job either.
    assert.deepStrictEqual(
      missingFromTriggerFilter(
        workflow(
          ["scripts/run-tauri-dev.test.mjs"],
          "node --test scripts/run-tauri-dev.test.mjs",
        ),
        scanRoot,
      ),
      [],
      "a filter that names the path the suite is run from is not missing it",
    );
  });

  it("still reports a scripts/ci suite whose filter omits it", () => {
    // The control for the one above: same shape, suite in `scripts/ci`, absent
    // from the filter. Without this the fix above would pass by ignoring every
    // path rather than by comparing them.
    assert.deepStrictEqual(
      missingFromTriggerFilter(
        workflow(
          ["apps/desktop/**"],
          "node --test scripts/ci/windows-tauri-imports.test.mjs",
        ),
        scanRoot,
      ),
      ["scripts/ci/windows-tauri-imports.test.mjs"],
      "naming the wrong directory is an omission, not an exemption",
    );
  });

  it("exempts a filter that names any whole directory it could run", () => {
    // One pattern per case, because the exemption is three independent literals
    // and a refactor that kept only the first would otherwise stay green.
    //
    // `.github/**` is not among them and cannot be: it matches no path under
    // `scripts/ci`, so a workflow carrying it and running a suite from there has
    // a real omission. `format-and-i18n.yml` lists it in both `paths:` blocks
    // today, so the shape is already in this tree -- it only runs no suite yet.
    for (const pattern of ["scripts/ci/**", "scripts/**", "**"]) {
      assert.deepStrictEqual(
        missingFromTriggerFilter(
          workflow(
            [pattern],
            "node --test scripts/ci/windows-tauri-imports.test.mjs",
          ),
          scanRoot,
        ),
        [],
        `${pattern} covers every suite in scripts/ci`,
      );
    }
    assert.deepStrictEqual(
      missingFromTriggerFilter(
        workflow(
          [".github/**"],
          "node --test scripts/ci/windows-tauri-imports.test.mjs",
        ),
        scanRoot,
      ),
      ["scripts/ci/windows-tauri-imports.test.mjs"],
      "a `.github/**` entry covers no suite in scripts/ci, so it is not an " +
        "exemption -- and one entry must not switch the check off for the file",
    );
  });

  it("reads a paths entry that is a glob rather than the exact suite path", () => {
    // GitHub's `paths:` filter is a glob list, so a workflow is entitled to name
    // its suites by pattern. Reading only an exact-path line reported a legal
    // filter as missing the suite, which is the false-positive direction: the
    // only fix available to the reader is to widen the entry past what they
    // meant, or to delete the guard.
    //
    // `*.test.mjs` is the control that keeps this from becoming a substring
    // match: GitHub's `*` does not cross a separator, so a top-level-only glob
    // genuinely does not cover `scripts/ci/`, and the guard has to say so.
    for (const entry of [
      "scripts/ci/*.test.mjs",
      "**/windows-tauri-imports.test.mjs",
      "scripts/ci/windows-tauri-imports.*",
      "**/*.test.mjs",
    ]) {
      assert.deepStrictEqual(
        missingFromTriggerFilter(
          workflow([entry], "node --test scripts/ci/windows-tauri-imports.test.mjs"),
          scanRoot,
        ),
        [],
        `a filter naming ${JSON.stringify(entry)} covers the suite and is not an omission`,
      );
    }
    assert.deepStrictEqual(
      missingFromTriggerFilter(
        workflow(["*.test.mjs"], "node --test scripts/ci/windows-tauri-imports.test.mjs"),
        scanRoot,
      ),
      ["scripts/ci/windows-tauri-imports.test.mjs"],
      "`*` does not cross a separator in a GitHub path filter, so a top-level " +
        "glob does not cover scripts/ci",
    );
  });

  it("reads only the entries of a paths block, not every list item in the file", () => {
    // `paths-ignore` is the inverse filter: a suite named there is one the
    // workflow is written not to start for. Counting it as coverage would make
    // the guard report "not missing" for a workflow that skips the suite
    // entirely, which is the direction that reassures.
    const text = [
      "on:",
      "  push:",
      "    paths:",
      '      - "scripts/**"',
      "    paths-ignore:",
      '      - "scripts/ci/windows-tauri-imports.test.mjs"',
      "jobs:",
      "  unit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node --test scripts/ci/windows-tauri-imports.test.mjs",
      "",
    ].join("\n");
    // `scripts/**` covers the suite, so the workflow is not missing an entry --
    // but only because of the `paths:` block. The `paths-ignore:` item must not
    // be what decided it, which is what the next case pins.
    assert.deepStrictEqual(
      missingFromTriggerFilter(text, scanRoot),
      [],
      "the paths block covers the suite, so this workflow is not missing it",
    );
    const ignored = text.replace('      - "scripts/**"\n', "");
    assert.deepStrictEqual(
      missingFromTriggerFilter(ignored, scanRoot),
      ["scripts/ci/windows-tauri-imports.test.mjs"],
      "a paths-ignore entry is not coverage: with no paths entry, the suite is " +
        "still an omission",
    );
  });

  it("one paths block naming the directory covers a second, narrower block", () => {
    // GitHub runs a workflow "if at least one path matches a pattern in the
    // `paths` filter", so the blocks are a union. A per-block rule would demand
    // the suite in both lists and fail a workflow that triggers correctly.
    const text = [
      "on:",
      "  push:",
      "    paths:",
      '      - "scripts/**"',
      "  pull_request:",
      "    paths:",
      '      - "apps/desktop/**"',
      "jobs:",
      "  unit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node --test scripts/ci/windows-tauri-imports.test.mjs",
      "",
    ].join("\n");
    assert.deepStrictEqual(
      missingFromTriggerFilter(text, scanRoot),
      [],
      "the blocks are OR'd, so one of them covering the suite is enough",
    );
  });

  it("reads a paths entry whatever its indent, and either way of quoting", () => {
    // `paths:` list items are indented six spaces in every workflow here, so a
    // matcher pinned to that indent would agree with all nine of them and be
    // wrong everywhere else. Unquoted and single-quoted forms included, because
    // a guard that only accepts the spelling this repository happens to use is
    // the same guard with a smaller view.
    const shapes = [
      '      - "scripts/ci/windows-tauri-imports.test.mjs"',
      "      - scripts/ci/windows-tauri-imports.test.mjs",
      "      - 'scripts/ci/windows-tauri-imports.test.mjs'",
      "    - scripts/ci/windows-tauri-imports.test.mjs",
      "        - scripts/ci/windows-tauri-imports.test.mjs",
    ];
    for (const entry of shapes) {
      assert.deepStrictEqual(
        missingFromTriggerFilter(
          [
            "on:",
            "  push:",
            "    paths:",
            entry,
            "jobs:",
            "  unit:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - run: node --test scripts/ci/windows-tauri-imports.test.mjs",
            "",
          ].join("\n"),
          scanRoot,
        ),
        [],
        `a filter naming the suite as ${JSON.stringify(entry)} is not missing it`,
      );
    }
  });

  it("says nothing about a workflow that triggers on every push", () => {
    assert.deepStrictEqual(
      missingFromTriggerFilter(
        [
          "on:",
          "  push:",
          "jobs:",
          "  unit:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: node --test scripts/ci/windows-tauri-imports.test.mjs",
          "",
        ].join("\n"),
        scanRoot,
      ),
      [],
      "there is no filter to keep in sync when there is no filter",
    );
  });
});
