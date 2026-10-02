import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse } from "smol-toml";

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
    const config = parse(
      readFileSync(resolve(repoRoot, ".deepsource.toml"), "utf8"),
    );
    const tracked = execSync("git ls-files", {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    assert.ok(
      Array.isArray(config.overrides) && config.overrides.length > 0,
      ".deepsource.toml must state which paths the analyzers skip",
    );

    for (const override of config.overrides) {
      const matchers = override.paths.map((pattern) => globToRegExp(pattern));
      const hit = tracked.filter((file) =>
        matchers.some((shape) => shape.test(file)),
      );
      assert.ok(
        hit.length > 0,
        `no tracked file matches ${override.paths.join(", ")}; the exclusion has rotted`,
      );
      for (const analyser of override.analyzers ?? []) {
        assert.equal(
          analyser.enabled,
          false,
          `${override.paths.join(", ")} excludes an analyzer instead of disabling it`,
        );
      }
    }
  });
});
