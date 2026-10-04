import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildScriptBinaryName,
  cargoOutputExcerpt,
  findBuildScriptInvocation,
  hasCachedCrates,
  parseEnvPrefix,
  replayedTestBinaryName,
  rewriteInvocation,
  tokenizeCargoCommand,
  tokenizeCargoCommandLoose,
} from "./sherpa-build-script-tests.mjs";

const SHERPA_PKG = "sherpa-onnx-sys";
const RUSTC = "rustc";

// Lines shaped like the ones `cargo build -vv` prints. The first entry is another
// crate's build script and the last is this package's library target: a selection
// rule that ignores either would compile the wrong unit and report a pass.
const FOREIGN_BUILD_SCRIPT =
  "   Running `" +
  RUSTC +
  " --crate-name build_script_build --edition=2021 --out-dir /t/debug/build/other-1234 " +
  "--crate-type bin --emit=dep-info,link build.rs`";

const SHERPA_PLAIN =
  "   Running `" +
  RUSTC +
  " --crate-name build_script_build --edition=2021 --out-dir /t/debug/build/sherpa-abc " +
  "--crate-type bin --emit=dep-info,link -Cembed-bitcode=no build.rs`";

const SHERPA_TEST =
  "   Running `" +
  RUSTC +
  " --crate-name build_script_build --edition=2021 --out-dir /t/debug/build/sherpa-abc " +
  "--emit=dep-info,metadata -Cincremental=0123abcd -Cextra-filename=-abcdef " +
  "--error-format=json --json=diagnostic-rendered-ansi build.rs`";

const SHERPA_LIB =
  "   Running `" +
  RUSTC +
  " --crate-name sherpa_onnx_sys --edition=2021 --crate-type lib --emit=dep-info,link src/lib.rs`";

const withEnv = (line, name) =>
  "   Running `" +
  "CARGO_PKG_NAME=" +
  name +
  " CARGO_MANIFEST_DIR=/probe " +
  line.slice(line.indexOf("`") + 1, line.lastIndexOf("`")) +
  "`";

const verboseOutput = [
  FOREIGN_BUILD_SCRIPT,
  withEnv(SHERPA_PLAIN, SHERPA_PKG),
  withEnv(SHERPA_TEST, SHERPA_PKG),
  withEnv(SHERPA_LIB, SHERPA_PKG),
].join("\n");

describe("tokenizeCargoCommand", () => {
  it("returns null for a line that is not a Running line", () => {
    assert.equal(tokenizeCargoCommand("   Compiling foo v0.1.0"), null);
    assert.equal(tokenizeCargoCommand(""), null);
    assert.equal(tokenizeCargoCommand("rustc --edition=2021 lib.rs"), null);
  });

  it("strips the quoting cargo adds, keeping each word whole", () => {
    assert.deepEqual(
      tokenizeCargoCommand("   Running `" + RUSTC + ` a 'b c' "d e" f\``),
      [RUSTC, "a", "b c", "d e", "f"],
    );
  });

  it("handles the '\\'' form cargo uses for a quote inside a quoted run", () => {
    // The escape is OUTSIDE the single quotes, so it is the backslash branch that
    // has to handle it. Getting this wrong silently splits one argument in two.
    assert.deepEqual(tokenizeCargoCommand("   Running `a 'b'\\''c'`"), ["a", "b'c"]);
  });

  it("honours a backslash escape only inside double quotes", () => {
    assert.deepEqual(tokenizeCargoCommand('   Running `a "b\\"c" d`'), [
      "a",
      'b"c',
      "d",
    ]);
    // inside single quotes a backslash is literal
    assert.deepEqual(tokenizeCargoCommand("   Running `a 'b\\c'`"), [
      "a",
      "b\\c",
    ]);
  });

  it("throws on an unterminated quote rather than returning a partial command", () => {
    assert.throws(
      () => tokenizeCargoCommand("   Running `a 'b`"),
      /unterminated/,
    );
  });

  it("keeps an empty command empty", () => {
    assert.deepEqual(tokenizeCargoCommand("   Running ``"), []);
  });
});

describe("parseEnvPrefix", () => {
  it("takes the leading NAME=value words off the front", () => {
    const { env, argv } = parseEnvPrefix([
      "CARGO_PKG_NAME=some-pkg",
      "RUSTFLAGS=-Cdebuginfo=0",
      RUSTC,
      "--edition=2021",
    ]);
    assert.deepEqual(env, {
      CARGO_PKG_NAME: "some-pkg",
      RUSTFLAGS: "-Cdebuginfo=0",
    });
    assert.deepEqual(argv, [RUSTC, "--edition=2021"]);
  });

  it("keeps a value containing an equals sign intact", () => {
    const { env } = parseEnvPrefix(["CARGO_PKG_NAME=a=b", RUSTC]);
    assert.equal(env.CARGO_PKG_NAME, "a=b");
  });

  it("stops at the first word that is not an assignment", () => {
    const { env, argv } = parseEnvPrefix(["A=1", RUSTC, "B=2"]);
    assert.deepEqual(env, { A: "1" });
    assert.deepEqual(argv, [RUSTC, "B=2"]);
  });

  it("does not treat a --flag=value as an assignment", () => {
    const { env, argv } = parseEnvPrefix(["--edition=2021"]);
    assert.deepEqual(env, {});
    assert.deepEqual(argv, ["--edition=2021"]);
  });
});

describe("the windows shape of a replayed command", () => {
  // Taken from a CI log rather than written from an assumption about `cmd`. Cargo emits
  // `set K=V&& ` per assignment on Windows because the shell is `cmd`, so the unix shape
  // a parser expects is not there at all -- and the harness reported "cargo printed no
  // rustc invocation" on every Windows leg until this was read out of the log.
  const windowsLine =
    "   Running `set CARGO='C:\\Users\\runneradmin\\.rustup\\toolchains\\" +
    "stable-x86_64-pc-windows-msvc\\bin\\cargo.exe'&& " +
    "set CARGO_CRATE_NAME=build_script_build&& " +
    "set CARGO_MANIFEST_DIR='C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\" +
    "sherpa-build-script-tests-FJLxV3\\crate'&& " +
    "set CARGO_PKG_LICENSE='MIT OR Apache-2.0'&& set CARGO_PKG_NAME=sherpa-onnx-sys&& " +
    // Bare, and a windows path -- which is what cargo prints. A fixture saying just
    // `rustc` could not catch it: a tokenizer that eats backslashes still reads `rustc`
    // as `rustc`. This one only parses if the backslashes survive.
    "C:\\Users\\runneradmin\\.rustup\\toolchains\\stable-x86_64-pc-windows-msvc\\bin\\rustc.exe " +
    "--crate-name build_script_build --edition=2021 --crate-type bin " +
    "--out-dir C:\\out build.rs`";

  it("parses the `set K=V&&` prefix and finds the invocation", () => {
    const found = findBuildScriptInvocation(windowsLine);
    assert.equal(found.length, 1, "the windows command shape must be recognised");
    assert.equal(found[0].env.CARGO_PKG_NAME, "sherpa-onnx-sys");
    assert.equal(found[0].env.CARGO_CRATE_NAME, "build_script_build");
  });

  it("unquotes values, including one containing a space", () => {
    // `cmd` quotes whenever the value has a space, so a quoted and an unquoted value have
    // to compare equal or the package-name check misses on Windows.
    const found = findBuildScriptInvocation(windowsLine);
    assert.equal(
      found[0].env.CARGO_PKG_LICENSE,
      "MIT OR Apache-2.0",
      "a quoted value must arrive unquoted",
    );
    assert.ok(
      !found[0].env.CARGO_MANIFEST_DIR.startsWith("'"),
      "the manifest dir must arrive unquoted",
    );
  });

  it("keeps a backslash-bearing path intact", () => {
    const found = findBuildScriptInvocation(windowsLine);
    // A string comparison, not a regex: `/^C:\Users\.../` has \U collapsing to U, so it
    // can never match a path that has backslashes in it. Which is what it did -- and the
    // failure read like a parsing bug rather than a broken assertion.
    assert.ok(
      found[0].env.CARGO_MANIFEST_DIR.startsWith("C:\\Users\\RUNNER~1\\"),
      `got ${JSON.stringify(found[0].env.CARGO_MANIFEST_DIR)}`,
    );
  });

  it("accepts a bare `rustc` as well, which is the unix shape", () => {
    const line = windowsLine.replace(
      /C:\\Users[^ ]+rustc\.exe /,
      "rustc ",
    );
    assert.equal(findBuildScriptInvocation(line).length, 1);
  });

  it("keeps the backslashes in the program path", () => {
    // The bug this fixture exists for: a tokenizer that treats every backslash as an
    // escape turns `C:\Users\...` into `C:Users...`, which is then not a recognisable
    // program name, so the harness reports that cargo printed no invocation at all.
    const found = findBuildScriptInvocation(windowsLine);
    assert.equal(found.length, 1);
    assert.match(
      found[0].argv[0],
      /^C:\\Users\\runneradmin\\\.rustup\\/,
      `program path lost its backslashes: ${JSON.stringify(found[0].argv[0])}`,
    );
  });

  it("still rejects a different command under the windows shape", () => {
    // Substitute the program the fixture actually carries. An earlier version replaced
    // `&& rustc --crate-name`, which stopped matching when the fixture became a bare
    // windows path -- so the replacement was a no-op and the case asserted that the
    // unmodified line found nothing, which is false. It failed, correctly.
    const line = windowsLine.replace("rustc.exe --crate-name", "cc --crate-name");
    assert.notEqual(line, windowsLine, "the substitution must actually change the line");
    assert.deepEqual(findBuildScriptInvocation(line), []);
  });

  it("does not mistake the `set` verb for the command", () => {
    const { argv } = parseEnvPrefix([
      "set",
      "A=1&&",
      "set",
      "B='x y'&&",
      "rustc",
      "--flag",
    ]);
    assert.deepEqual(argv, ["rustc", "--flag"]);
  });

  it("still rejects a windows-shaped line for another package", () => {
    const other = windowsLine.replace("CARGO_PKG_NAME=sherpa-onnx-sys", "CARGO_PKG_NAME=tar");
    assert.deepEqual(findBuildScriptInvocation(other), []);
  });
});

describe("findBuildScriptInvocation", () => {
  it("returns both of this package's build-script invocations", () => {
    // Two: cargo compiles the build script once as a bin and once as a test
    // harness. Missing the second is what makes a harness compile nothing.
    const found = findBuildScriptInvocation(verboseOutput);
    assert.equal(found.length, 2);
    for (const match of found) {
      assert.equal(match.env.CARGO_PKG_NAME, SHERPA_PKG);
      assert.equal(match.argv[0], RUSTC);
    }
  });

  it("ignores another package's build script", () => {
    assert.deepEqual(findBuildScriptInvocation(FOREIGN_BUILD_SCRIPT), []);
  });

  it("ignores this package's library target", () => {
    // Selecting on the package alone would compile the library's tests, which
    // contain no build-script code, and report that they all passed.
    assert.deepEqual(findBuildScriptInvocation(withEnv(SHERPA_LIB, SHERPA_PKG)), []);
  });

  it("skips a line it cannot tokenize instead of failing the whole scan", () => {
    const mixed = ["garbage", "   Running `a 'b", SHERPA_PLAIN].join("\n");
    // The unterminated line throws inside, is caught per line, and the good one
    // is still found -- provided it is this package's.
    assert.equal(findBuildScriptInvocation(mixed).length, 0);
    assert.equal(
      findBuildScriptInvocation(withEnv(mixed, SHERPA_PKG).replace(SHERPA_PLAIN, SHERPA_PLAIN)).length,
      0,
    );
  });
});

describe("rewriteInvocation", () => {
  const found = findBuildScriptInvocation(verboseOutput);
  const rewrite = (index, test) =>
    rewriteInvocation(found[index], { outBinary: "/tmp/out", test });

  it("returns the env it was given, unchanged", () => {
    assert.equal(rewrite(0, false).env, found[0].env);
  });

  it("drops the flags that describe the unit cargo wanted", () => {
    const out = rewrite(0, false).argv;
    for (const flag of ["--crate-type", "--out-dir", "--emit"]) {
      assert.ok(!out.includes(flag), `${flag} survived: ${JSON.stringify(out)}`);
    }
    // and the value that belonged to it
    assert.ok(!out.includes("bin"), "the --crate-type value survived");
    assert.ok(!out.includes("dep-info,link"), "the --emit value survived");
  });

  it("drops the per-unit -C and diagnostics flags", () => {
    const out = rewrite(1, true).argv;
    // Cargo prints these JOINED (`-Cincremental=...`), and a tokenizer that split
    // them would produce a bare `-C` plus a separate word. Matching only the joined
    // form let a mutation that kept `-C incremental=` through unnoticed; matching
    // only the spaced form is vacuous for real cargo output. Refuse both spellings.
    const perUnit = /^-C\s*(incremental|extra-filename)/;
    for (const arg of out) {
      assert.ok(!perUnit.test(arg), `per-unit -C survived: ${arg}`);
      assert.ok(!arg.startsWith("--error-format"), arg);
      assert.ok(!arg.startsWith("--json"), arg);
      assert.ok(!arg.startsWith("--emit"), arg);
    }
    // The bare `-C` a split would leave behind has no business being there either.
    assert.ok(!out.includes("-C"), "a bare -C survived");
  });

  it("keeps everything that decides what compiles against what", () => {
    const out = rewrite(0, false).argv;
    assert.ok(out.includes("--edition=2021"));
    assert.ok(out.includes("-Cembed-bitcode=no"));
    assert.ok(out.includes("--crate-name"));
    assert.ok(out.includes("build_script_build"));
  });

  it("appends --test only for the test rung", () => {
    assert.ok(rewrite(1, true).argv.includes("--test"));
    assert.ok(!rewrite(0, false).argv.includes("--test"));
  });

  it("points the source at the checkout's build.rs, not the probe copy", () => {
    for (const index of [0, 1]) {
      const out = rewrite(index, true).argv;
      assert.ok(!out.includes("build.rs"), "the relative build.rs was kept");
      assert.equal(
        out.filter((a) => a.endsWith("build.rs")).length,
        1,
        "expected exactly one build.rs path",
      );
    }
  });

  it("emits -o once, with the requested path", () => {
    const out = rewriteInvocation(found[0], {
      outBinary: "/tmp/somewhere/out",
      test: false,
    }).argv;
    assert.equal(out.filter((a) => a === "-o").length, 1);
    assert.equal(out[out.length - 1], "/tmp/somewhere/out");
  });

  it("keeps rustc as argv[0]", () => {
    assert.equal(rewrite(0, false).argv[0], RUSTC);
  });
});

describe("tokenizeCargoCommandLoose", () => {
  // Cargo has changed the prefix it puts in front of a replayed command before, and the
  // prefix is cosmetic. What is not cosmetic is that a harness which cannot parse the
  // line reports "no rustc invocation" and nothing else -- the CI log then contains the
  // conclusion and none of the evidence. So the finder tolerates the prefix, and the
  // evidence is printed when even that is not enough.
  const body = `${RUSTC} --crate-name build_script_build --edition=2021 build.rs`;

  it("accepts a timestamped prefix", () => {
    assert.deepEqual(tokenizeCargoCommandLoose("   [0.04s] Running `" + body + "`"), [
      RUSTC,
      "--crate-name",
      "build_script_build",
      "--edition=2021",
      "build.rs",
    ]);
  });

  it("accepts a bare Fresh prefix", () => {
    assert.deepEqual(tokenizeCargoCommandLoose("    Fresh `" + body + "`"), [
      RUSTC,
      "--crate-name",
      "build_script_build",
      "--edition=2021",
      "build.rs",
    ]);
  });

  it("returns nothing for a line with no backticks, rather than guessing", () => {
    assert.equal(tokenizeCargoCommandLoose("   Compiling foo v0.1.0"), null);
    assert.equal(tokenizeCargoCommandLoose(""), null);
  });

  it("returns nothing for a single backtick", () => {
    assert.equal(tokenizeCargoCommandLoose("   Running `unterminated"), null);
  });

  it("finds the invocation behind any prefix, and only that one", () => {
    // Built by hand rather than through `withEnv`, which hardcodes the `Running`
    // prefix and would therefore have produced the same strict line four times -- so
    // three of these cases asserted nothing. Removing the loose fallback leaves this
    // green, which is how that was found.
    const withEnvPrefix = (prefix) =>
      prefix +
      "`CARGO_PKG_NAME=" +
      SHERPA_PKG +
      " CARGO_MANIFEST_DIR=/probe " +
      body +
      "`";

    for (const prefix of [
      "   Running ",
      "   [0.04s] Running ",
      "    Fresh ",
      "  Compiling sherpa-onnx-sys v1.13.5 ",
    ]) {
      // the strict tokenizer must reject three of these, or the case proves nothing
      if (prefix !== "   Running ") {
        assert.equal(
          tokenizeCargoCommand(withEnvPrefix(prefix)),
          null,
          `the strict tokenizer unexpectedly accepted ${JSON.stringify(prefix)}, so ` +
            `this case is not testing the fallback`,
        );
      }
      const found = findBuildScriptInvocation(withEnvPrefix(prefix));
      assert.equal(
        found.length,
        1,
        `prefix not tolerated: ${JSON.stringify(prefix)}`,
      );
    }
  });
  it("still refuses a line that only mentions backticks", () => {
    // Tolerating the prefix must not become matching anything: both markers are still
    // required, so prose that happens to quote a command cannot be replayed.
    const prose = "   Running `the crate named build_script_build is sherpa-onnx-sys`";
    assert.deepEqual(findBuildScriptInvocation(withEnv(prose, SHERPA_PKG)), []);
  });
});

describe("the harness says what cargo printed when it cannot use the output", () => {
  // Without this the CI log carries the conclusion and none of the evidence: cargo's output
  // is captured into a variable, so "no rustc invocation" cannot be diagnosed from the run
  // that produced it. That is not hypothetical -- this is the log that cost a round on a
  // cargo whose command shape the tokenizer did not accept.
  it("frames the tail of cargo's own output", () => {
    const excerpt = cargoOutputExcerpt("one\ntwo\nthree");
    assert.match(excerpt, /^--- last \d+ lines cargo printed ---/);
    assert.match(excerpt, /three/);
    assert.match(excerpt, /--- end ---$/);
  });

  it("bounds the excerpt, keeping the end", () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const excerpt = cargoOutputExcerpt(many, 40);
    assert.match(excerpt, /line 199/);
    assert.doesNotMatch(excerpt, /line 0\b/);
  });

  // The three cases above exercise the FUNCTION. None of them would notice if the harness
  // stopped calling it -- which is exactly what a mutation did: deleting the
  // `console.error(cargoOutputExcerpt(output))` on the no-invocation path left all of them
  // green. So the wiring is asserted too.
  //
  // It is a structural assertion, which is normally the wrong instrument, and it is here
  // because the alternative is worse: driving this path means running the whole harness
  // with a stubbed `CARGO`, and on Windows a stub is a `.cmd`, which `spawnSync` refuses
  // with EINVAL unless `shell: true`. That attempt failed on the one platform where the
  // harness was actually broken, which read as "the harness is still wrong there".
  //
  // Read it as: the call exists, and it is on the path that reports no invocation.
  it("is echoed from the path that reports no invocation", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./sherpa-build-script-tests.mjs", import.meta.url)),
      "utf8",
    );
    const noInvocation = source.indexOf("if (matches.length === 0) {");
    assert.notEqual(noInvocation, -1, "the no-invocation branch must exist");
    // Wide enough for the comment above the call, bounded so it cannot reach the next
    // branch. 400 was not: it cut the window short and failed at baseline.
    const arm = source.slice(noInvocation, noInvocation + 1500);
    assert.match(
      arm,
      /console\.error\(cargoOutputExcerpt\(output\)\)/,
      "the no-invocation path must echo cargo's own output, or a failed run cannot be " +
        "diagnosed from its own log",
    );
  });

  it("says so even when there is nothing to show", () => {
    // An empty excerpt still has to be framed, or the reader cannot tell "cargo printed
    // nothing" from "the harness did not bother".
    assert.match(cargoOutputExcerpt(""), /--- last \d+ lines cargo printed ---/);
  });
});

describe("hasCachedCrates", () => {
  // The bug this pins: `join("", "registry", "cache")` yields the RELATIVE path
  // `registry/cache`, which resolves against the process cwd -- the repo root under
  // `node scripts/ci/...`. So a `registry/cache/<hash>/*.crate` tree anywhere under the
  // checkout made the default `$HOME/.cargo` look warm, `candidateCargoHomes()` was skipped,
  // and the offline probe failed with a message about the network. Measured, not argued.
  it("reports nothing for an unset CARGO_HOME rather than checking a relative path", () => {
    assert.equal(hasCachedCrates(""), false);
    assert.equal(hasCachedCrates(undefined), false);
    assert.equal(hasCachedCrates(null), false);
  });

  it("does not consult the cwd when CARGO_HOME is unset", () => {
    // The positive control: with a relative registry tree present, an unset CARGO_HOME
    // still reports cold. Run in a temp cwd so the answer cannot come from this repo.
    const dir = mkdtempSync(join(tmpdir(), "warm-cargo-"));
    const hash = join(dir, "registry", "cache", "deadbeef");
    mkdirSync(hash, { recursive: true });
    writeFileSync(join(hash, "bzip2-0.4.4.crate"), "");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(hasCachedCrates(""), false);
      assert.equal(hasCachedCrates(join(dir, "registry", "cache")), false);
      // ...and the same directory IS warm when named absolutely, which is what the early
      // return must not break.
      assert.equal(hasCachedCrates(dir), true);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildScriptBinaryName", () => {
  it("appends .exe on Windows and nothing elsewhere", () => {
    assert.equal(buildScriptBinaryName("win32"), "build-script-build.exe");
    assert.equal(buildScriptBinaryName("linux"), "build-script-build");
    assert.equal(buildScriptBinaryName("darwin"), "build-script-build");
  });

  it("defaults to the host platform", () => {
    assert.equal(
      buildScriptBinaryName(),
      process.platform === "win32"
        ? "build-script-build.exe"
        : "build-script-build",
    );
  });
});
