import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repoRoot, "scripts/ci/run-alsa-fault-tests.sh");
const cpalTests = join(
  repoRoot,
  "apps/desktop/src-tauri/src/platform/audio.rs",
);
const fixtureDir = join(repoRoot, "apps/desktop/src-tauri/tests/fixtures");

/**
 * The ALSA fault tests are `#[ignore]`d because they need a null device and an
 * `LD_PRELOAD` shim, and `cargo test --lib` supplies neither. That is a fair
 * reason to skip them by default and a bad reason for them to be unreachable:
 * `scripts/ci/run-alsa-fault-tests.sh` is the only thing that runs them, so a
 * test added to `audio.rs` without a row there is dead weight that reads as
 * coverage, and a row naming a test that no longer exists fails only when
 * somebody runs the script.
 *
 * These checks are static: no compiler, no ALSA, no preload. They run in the
 * same `node --test`-style step as the other guards.
 */

const scriptText = readFileSync(scriptPath, "utf8");

// `"<fixture>|<env>|<test>"` rows, one per line, inside the `rows=(...)` array.
const rows = [...scriptText.matchAll(/^\s*"(?<row>[^"|]*\|[^"|]*\|[^"]+)",?$/gm)].map(
  (match) => {
    const [fixture, env, test] = match.groups.row.split("|");
    return { fixture, env, test, row: match.groups.row };
  },
);

const rustIgnoredTests = (() => {
  const source = readFileSync(cpalTests, "utf8");
  // `#[ignore = "..."]` followed by any number of attribute lines and then the
  // `fn`. The message is kept so a test that is ignored for an unrelated reason
  // (a physical microphone, a real device) is not demanded of this script.
  const pattern =
    /#\[ignore = "(?<message>[^"]+)"\]\s*(?:#\[[^\]]*\]\s*)*fn (?<name>[a-z0-9_]+)\(\)/g;
  return [...source.matchAll(pattern)]
    .map((match) => ({ name: match.groups.name, message: match.groups.message }))
    .filter((entry) => /ALSA/i.test(entry.message))
    .map((entry) => entry.name);
})();

const fixtureFiles = readdirSync(fixtureDir)
  .filter((file) => /^alsa_.*\.c$/.test(file))
  .map((file) => file.replace(/\.c$/, ""));

describe("ALSA fault-injection runner", () => {
  it("defines at least one row", () => {
    assert.ok(rows.length > 0, "the runner must define rows");
  });

  it("names a fixture for every row, and only files that exist", () => {
    const used = new Set();
    for (const { fixture, row } of rows) {
      if (fixture === "-") continue;
      assert.ok(
        fixtureFiles.includes(fixture),
        `row "${row}" names fixture ${fixture}.c, which is not in tests/fixtures`,
      );
      used.add(fixture);
    }
    assert.ok(used.size > 0, "at least one row must preload a fixture");
  });

  it("leaves no fixture unloadable from a row", () => {
    const referenced = new Set(rows.map(({ fixture }) => fixture));
    const orphans = fixtureFiles.filter((fixture) => !referenced.has(fixture));
    assert.deepEqual(
      orphans,
      [],
      "these fixtures exist but no row preloads them, so they cannot be reached",
    );
  });

  it("covers every ALSA test that audio.rs ignores", () => {
    assert.ok(
      rustIgnoredTests.length > 0,
      "audio.rs must still contain the ALSA fault tests",
    );
    const covered = new Set(rows.map(({ test }) => test));
    const missing = rustIgnoredTests.filter((name) => !covered.has(name));
    assert.deepEqual(
      missing,
      [],
      "these tests are #[ignore]d in audio.rs and have no row in the runner",
    );
  });

  it("does not run a test that audio.rs does not ignore", () => {
    const ignored = new Set(rustIgnoredTests);
    const unknown = rows
      .map(({ test }) => test)
      .filter((name) => !ignored.has(name));
    assert.deepEqual(
      unknown,
      [],
      "these rows name tests that are not #[ignore]d ALSA tests in audio.rs",
    );
  });

  it("runs every row in the module that holds the tests", () => {
    assert.match(
      scriptText,
      /test_module="platform::audio::cpal_impl::tests"/,
      "rows are filtered with --exact, so the module path must match audio.rs",
    );
  });

  it("runs each row in its own process", () => {
    // A preload interposes process-wide symbols and an armed fault is one-shot
    // state in the shim, so a shared process would leak faults between rows.
    assert.match(scriptText, /--test-threads=1/);
    assert.match(scriptText, /--exact/);
    assert.match(
      scriptText,
      /LD_PRELOAD="\$preload" "\$test_binary"/,
      "the shim must be preloaded into the test binary, not into cargo",
    );
  });
});
