import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
 * The coverage checks are static. Runner checks use fake cargo and test binaries,
 * so they need no compiler or ALSA device.
 */

const scriptText = readFileSync(scriptPath, "utf8");

// `"<fixture>|<env>|<test>"` rows, one per line, inside the `rows=(...)` array.
const rows = [
  ...scriptText.matchAll(/^\s*"(?<row>[^"|]*\|[^"|]*\|[^"]+)",?$/gm),
].map((match) => {
  const [fixture, env, test] = match.groups.row.split("|");
  return { fixture, env, test, row: match.groups.row };
});

const rustIgnoredTests = (() => {
  const source = readFileSync(cpalTests, "utf8");
  // `#[ignore = "..."]` followed by any number of attribute lines and then the
  // `fn`. The message is kept so a test that is ignored for an unrelated reason
  // (a physical microphone, a real device) is not demanded of this script.
  const pattern =
    /#\[ignore = "(?<message>[^"]+)"\]\s*(?:#\[[^\]]*\]\s*)*fn (?<name>[a-z0-9_]+)\(\)/g;
  return [...source.matchAll(pattern)]
    .map((match) => ({
      name: match.groups.name,
      message: match.groups.message,
    }))
    .filter((entry) => /ALSA/i.test(entry.message))
    .map((entry) => entry.name);
})();

const fixtureFiles = readdirSync(fixtureDir)
  .filter((file) => /^alsa_.*\.c$/.test(file))
  .map((file) => file.replace(/\.c$/, ""));

function runWithFakeTestBinary(output, filter, status = 0) {
  const directory = mkdtempSync(join(tmpdir(), "alsa-runner-"));
  try {
    const cargo = join(directory, "cargo");
    const binary = join(directory, "test-binary");
    writeFileSync(
      cargo,
      '#!/bin/sh\nprintf \'{"executable":"%s"}\\n\' "$FAKE_TEST_BINARY"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      binary,
      '#!/bin/sh\nprintf "%s\\n" "$FAKE_TEST_OUTPUT"\nexit "$FAKE_TEST_STATUS"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [scriptPath, filter], {
      encoding: "utf8",
      env: {
        ...process.env,
        MAUS_ALSA_FAULT_CARGO: cargo,
        MAUS_ALSA_FAULT_CC: "/bin/true",
        MAUS_ALSA_FAULT_WORKDIR: join(directory, "work"),
        FAKE_TEST_BINARY: binary,
        FAKE_TEST_OUTPUT: output,
        FAKE_TEST_STATUS: String(status),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

  it(
    "requires a selected test to execute and pass",
    { skip: process.platform !== "linux" },
    () => {
      const filter =
        "cpal_worker_captures_and_hands_off_on_an_alsa_null_device";
      const passed = runWithFakeTestBinary(
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
        filter,
      );
      assert.equal(passed.status, 0, passed.stdout + passed.stderr);
      const crashed = runWithFakeTestBinary(
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
        filter,
        1,
      );
      assert.notEqual(crashed.status, 0, crashed.stdout + crashed.stderr);
      for (const output of [
        "",
        "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
        "test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
      ]) {
        const result = runWithFakeTestBinary(output, filter);
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
      }
    },
  );

  it(
    "rejects a filter that selects no tests",
    { skip: process.platform !== "linux" },
    () => {
      const result = runWithFakeTestBinary("", "no-such-alsa-test");
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
    },
  );

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
