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
      const paths = [...block.matchAll(/^\s*paths\s*=\s*\[(.*)\]\s*$/gm)]
        .flatMap((matched) => matched[1].split(","))
        .map((path) => path.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      assert.ok(
        paths.length > 0,
        "an [[overrides]] block must list the paths it skips",
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
    const unwired = suites.filter((suite) => !workflows.includes(suite));
    assert.deepStrictEqual(
      unwired,
      [],
      `these guards are never run, so they assert nothing: ${unwired.join(", ")}`,
    );
  });
});
