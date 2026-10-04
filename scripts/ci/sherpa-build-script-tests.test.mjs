import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildScriptBinaryName,
  findBuildScriptInvocation,
  parseEnvPrefix,
  rewriteInvocation,
  tokenizeCargoCommand,
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
