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

// Every `scripts/ci` suite the workflow text would actually execute.
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
        executed.add(name);
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
          executed.add(file);
        }
      }
    }
  }
  return executed;
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
      for (const suite of [...reached]) {
        for (const next of imported.get(suite) ?? []) {
          if (!reached.has(next)) {
            reached.add(next);
            grew = true;
          }
        }
      }
    }

    const unwired = suites.filter((suite) => !reached.has(suite));
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
  // `test-desktop-unit.yml` was missing six of the eleven suites it runs, so a
  // change to any of them skipped the workflow that executes it.
  it("a suite a workflow runs is in that workflow's trigger filter", () => {
    const dir = resolve(repoRoot, ".github/workflows");
    const offenders = [];
    for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const text = readFileSync(resolve(dir, file), "utf8");
      // Only a workflow with a `paths:` filter can be missing an entry. One that
      // triggers on every push has nothing to keep in sync.
      const filtered = /^\s*paths:\s*$/m.test(text);
      if (!filtered) continue;
      const executed = executedSuites(text, repoRoot);
      if (executed.size === 0) continue;
      // A filter that already names the whole directory covers every suite in
      // it, so it is not an omission.
      const wholeDir = [...executed].every(
        (suite) =>
          /^\s*-\s*["']?scripts\/ci\/\*\*["']?\s*$/m.test(text) ||
          /^\s*-\s*["']?scripts\/\*\*["']?\s*$/m.test(text) ||
          /^\s*-\s*["']?\*\*["']?\s*$/m.test(text) ||
          /^\s*-\s*["']?\.github\/\*\*["']?\s*$/m.test(text),
      );
      if (wholeDir) continue;
      const missing = [...executed].filter(
        (suite) =>
          !new RegExp(
            `^\\s*-\\s*["']?scripts/ci/${suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*$`,
            "m",
          ).test(text),
      );
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
      ["dev-surface-contracts.test.mjs"],
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
      ["release-notes.test.mjs", "validate-release-inputs.test.mjs"],
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
      found.has("windows-tauri-imports.test.mjs") &&
        found.has("check-workspace-hygiene.test.mjs"),
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
      ["windows-tauri-imports.test.mjs"],
      "a `paths:` entry or a mention in prose is not a suite anything executes",
    );
  });
});
