// Compiles and runs the `#[cfg(test)] mod tests` in
// `patches/sherpa-onnx-sys-1.13.5/build.rs`.
//
// Cargo builds a build script as an ordinary binary (`--crate-type bin`) and runs
// it. Nothing in this repository ever builds one under `--test`, so the tests in
// that file have never run: `cargo test`, `cargo test --all-targets` and
// `cargo clippy --all-targets` all report `0 passed; 0 failed` for it, and a hard
// type error planted inside `mod tests` leaves all three still exiting 0. Those
// tests cover the only decision this build script makes about the extracted
// cache, so "they compile" is not a formality.
//
// The rustc invocation is not written out here. Cargo is asked for it with
// `cargo build -vv`, which prints the exact command line it uses for the build
// script, and that line is replayed with `--test` appended. Deriving the flags
// that way is what keeps the harness honest as the build-dependency set changes:
// a hand-written `--extern` list would go stale silently, and then either fail to
// compile or compile against the wrong rlib.
//
// Two things this deliberately does not do:
//
//   * It never lets the build script download a prebuilt archive. The probe build
//     runs with `DOCS_RS=1`, which makes `try_main` return before it reaches
//     `download_prebuilt_libs` at all -- that is the switch the build script
//     already provides for exactly this purpose (docs.rs sets it), so a cold cache
//     cannot turn this into a 22 MB download. The tests themselves drive
//     `download_prebuilt_libs` against a temp cache holding a small synthetic
//     `.tar.bz2`, so they do not reach the network either.
//
//   * It never silently passes. Every failure mode -- cargo failing, the
//     invocation not being found, the replay failing to compile, a test failing,
//     the wrong number of tests running -- exits non-zero with a message naming
//     the cause. A harness that could not run the tests must never look like a
//     run that passed them.
//
// Run with:
//   node scripts/ci/sherpa-build-script-tests.mjs
//
// Set SHERPA_BUILD_SCRIPT_TESTS_ALLOW_FETCH=1 to let the probe build reach the
// network for build-dependencies that are not in the local cargo cache. It is off
// by default. CI runs this step after a `cargo test` of the transcription package,
// which has already fetched them, so the offline probe is enough there.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const patchDir = join(repoRoot, "patches", "sherpa-onnx-sys-1.13.5");
const buildRs = join(patchDir, "build.rs");
const manifest = join(patchDir, "Cargo.toml");
// The patch crate is reached through `[patch.crates-io]` from the transcription
// package, so this -- not the patch crate's own directory -- is where a lockfile
// covering its build-dependencies lives.
const workspaceLock = join(
  repoRoot,
  "packages",
  "rust_transcription",
  "Cargo.lock",
);

// Every build script cargo compiles is called this, which is why the unit is also
// selected by `CARGO_PKG_NAME`: matching on the crate name alone would happily
// compile some dependency's tests instead of this file's.
const BUILD_SCRIPT_CRATE_NAME = "build_script_build";
const SHERPA_PKG_NAME = "sherpa-onnx-sys";

// Must match `PINNED_DIGEST_OVERRIDE_MARKER` in build.rs. Its presence in the test
// binary and absence from the build script cargo actually produced is what shows
// the test-only digest override cannot reach a real build. build.rs has a test
// pinning the same literal, so the two cannot drift apart unnoticed.
const OVERRIDE_MARKER = "sherpa-pinned-digest-override-cfg-test-only";

// The tests this harness exists to run, named so a module that silently loses one
// cannot pass. `exit 0` from the test binary is not on its own evidence that
// anything ran: `#[cfg(test)]` matching nothing, a renamed module, or a `mod tests`
// emptied by a bad merge all produce a green test binary that asserted nothing.
// Cargo has no way to fail on that, so the names are pinned here instead.
const REQUIRED_TESTS = [
  // The pure helpers, which cargo never compiled before this harness existed.
  "tests::digest_is_stable_across_calls",
  "tests::digest_changes_when_a_library_is_rewritten",
  "tests::digest_changes_when_a_file_is_added",
  "tests::digest_changes_when_a_file_is_renamed_without_disturbing_the_sort_order",
  "tests::digest_distinguishes_content_swapped_between_two_paths",
  "tests::verify_accepts_an_untouched_tree_and_rejects_a_rewritten_one",
  "tests::verify_rejects_an_empty_recorded_digest",
  "tests::verify_rejects_a_missing_tree",
  "tests::record_is_case_insensitive_on_read_back",
  // Collision resistance of the digest stream. Sixteen green tests once did not
  // catch a re-parsable framing, because every one of them fed the digest an honest
  // tree; these are the two that make two different trees agree on the bytes.
  // The second is the layout-independent one and is the one that matters: it holds
  // the tree's bytes fixed and moves only a file boundary.
  "tests::a_forged_tree_is_not_accepted_as_the_tree_whose_digest_it_carries",
  "tests::moving_a_byte_across_a_file_boundary_changes_the_digest",
  // The wiring: whether a cache hit is taken at all.
  "tests::a_tampered_extracted_tree_is_not_reused",
  "tests::a_tree_with_no_recorded_digest_is_not_reused",
  "tests::the_repair_path_re_extracts_instead_of_downloading",
  "tests::a_tree_whose_archive_is_missing_is_not_reused",
  // The ones that keep this harness's premise, and `pinned_archive_digest`'s
  // production branch, honest.
  //
  // The third was `the_pinned_digest_override_is_absent_when_the_file_is_not_built_as_a_test`,
  // which asserted `installed == Some(wiring_archive_name())` -- a tautology, since
  // `wiring_archive_name()` produces both sides. It is now
  // `the_wiring_archive_has_a_production_pin`, which asserts the pin table actually
  // contains the wiring archive: delete that entry and every override path still
  // passes. The name is renamed here too, because pinning a name that no longer exists
  // is what this list exists to prevent -- the harness caught the rename on its first
  // run against the edited build.rs, which is the whole reason the list is by name.
  "tests::pinned_digests_come_from_the_table_for_every_pinned_archive",
  "tests::the_test_only_digest_override_cannot_reach_a_real_build",
  "tests::the_wiring_archive_has_a_production_pin",
];

class HarnessError extends Error {}

/** How much of cargo's own output to echo when the harness cannot use it. */
const CARGO_OUTPUT_EXCERPT_LINES = 40;

/**
 * The tail of what cargo printed, for the log.
 *
 * Exported so it can be tested without running cargo. An earlier version of that test ran
 * the whole harness with a stub `CARGO`, which does not work on Windows: a `.cmd` needs
 * `shell: true` and `spawnSync` answers EINVAL without it. So the test passed on the two
 * platforms where the harness worked and failed on the one where it was broken, which is
 * the worst possible split -- it looked like the harness was still wrong there.
 *
 * `lines` is the tail of `stdout + stderr` concatenated. Cargo writes its replayed
 * commands to one stream and its progress to the other, so the interesting lines can be
 * anywhere in that concatenation; that is why this is a tail of the whole and not of
 * either half.
 */
export function cargoOutputExcerpt(output, lines = CARGO_OUTPUT_EXCERPT_LINES) {
  return (
    `--- last ${lines} lines cargo printed ---\n` +
    output.split("\n").slice(-lines).join("\n") +
    "\n--- end ---"
  );
}

/** Report why the harness could not do its job, and exit non-zero. */
function fail(msg) {
  throw new HarnessError(msg);
}

/**
 * Splits one of cargo's `Running \`...\`` lines into words.
 *
 * Cargo quotes with the shell, so this has to understand `'...'`, `"..."` and
 * backslash escapes outside quotes -- including the `'\''` form it uses for a
 * single quote inside a single-quoted run. Returns null for a line that is not a
 * `Running` line at all.
 */
export function tokenizeCargoCommand(line) {
  const match = /^\s*Running\s+`([\s\S]*)`\s*$/.exec(line);
  if (!match) return null;
  return splitCommandWords(match[1]);
}

/**
 * The same, for a line whose prefix is not the literal word `Running`.
 *
 * Cargo has changed what it puts in front of a replayed command before, and the prefix is
 * cosmetic: what matters is that the command is backtick-quoted, which is how cargo has
 * always quoted it. Taking the text between the FIRST and the LAST backtick tolerates
 * `[0.04s] Running \`...\``, `Fresh \`...\`` and whatever comes next.
 *
 * This is not a licence to match anything. Both markers are still required --
 * `CARGO_PKG_NAME=sherpa-onnx-sys` AND `--crate-name build_script_build` -- so a line that
 * merely mentions backticks produces words that match neither. The cost of this being too
 * permissive is a diagnostic that is harder to read, not a wrong build script compiled:
 * a false positive here still has to satisfy the package name and the crate name, and the
 * replayed command is checked against what cargo would accept.
 */
export function tokenizeCargoCommandLoose(line) {
  const first = line.indexOf("`");
  if (first === -1) return null;
  const last = line.lastIndexOf("`");
  if (last <= first) return null;
  return splitCommandWords(line.slice(first + 1, last));
}

/**
 * Whether a backslash before `ch` is an escape rather than a literal backslash.
 *
 * Only for the characters where a backslash has to mean something: whitespace, a quote,
 * a backtick, `$`, and another backslash. Everywhere else it is a literal backslash, and
 * that distinction is the whole reason this harness can read cargo's output on Windows.
 *
 * Cargo prints the rustc path bare there -- `C:\Users\...\rustc.exe` -- so treating
 * every backslash as an escape deleted each one (`\U` is just `U`), argv[0] stopped being
 * a recognisable program name, and every windows leg reported that cargo had printed no
 * invocation at all.
 *
 * `'` is in the set because of cargo's `set K='v'&&` output and the `\'\''` form it uses to
 * embed a quote: a backslash before a quote is an escape in both cases, and dropping it
 * would merge two arguments into one.
 */
const isEscapable = (ch) => /[\s'"`$\\]/.test(ch);

function splitCommandWords(body) {
  const words = [];
  let current = "";
  let started = false;
  let index = 0;
  while (index < body.length) {
    const ch = body[index];
    if (ch === "'" || ch === '"') {
      const startedQuote = ch;
      started = true;
      index += 1;
      while (index < body.length && body[index] !== startedQuote) {
        // Inside single quotes a backslash is literal, so only the double-quoted case
        // honours an escape -- and then only for the characters a POSIX shell actually
        // escapes. Honouring it for every backslash destroys Windows paths: cargo
        // double-quotes the rustc path there, so `C:\Users\...\rustc.exe` lost every
        // backslash (`\U` is just `U`), argv[0] stopped being a recognisable program
        // name, and the harness reported that cargo had printed no invocation at all.
        // A shell leaves `\Q` alone for exactly this reason.
        if (
          startedQuote === '"' &&
          body[index] === "\\" &&
          index + 1 < body.length &&
          isEscapable(body[index + 1])
        ) {
          current += body[index + 1];
          index += 2;
          continue;
        }        current += body[index];
        index += 1;
      }
      if (index >= body.length) {
        throw new Error(`unterminated ${startedQuote} quote in a cargo command line`);
      }
      index += 1;
      continue;
    }
    // Same rule outside quotes as inside them: a backslash only escapes what a shell
    // escapes. Cargo prints the rustc path BARE on windows -- `C:\Users\...\rustc.exe`
    // -- so treating every backslash as an escape here removed each one (`\U` is just
    // `U`), argv[0] stopped being a recognisable program name, and the harness reported
    // that cargo had printed no invocation. This was the cause on the windows legs; the
    // quoted case above was a second instance of the same mistake, found by the fix.
    if (
      ch === "\\" &&
      index + 1 < body.length &&
      isEscapable(body[index + 1])
    ) {
      started = true;
      current += body[index + 1];
      index += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      index += 1;
      continue;
    }
    started = true;
    current += ch;
    index += 1;
  }
  if (started) words.push(current);
  return words;
}

/**
 * Splits the `NAME=value` assignments cargo prefixes a command with.
 *
 * Two shapes, because cargo emits two:
 *
 *     unix     CARGO_PKG_NAME=sherpa-onnx-sys CARGO_MANIFEST_DIR=/x rustc ...
 *     windows  set CARGO_PKG_NAME=sherpa-onnx-sys&& set CARGO_MANIFEST_DIR=C:\x&& rustc ...
 *
 * The Windows form is `set K=V&& ` per assignment, because the shell is `cmd`. Measured
 * from a CI log rather than guessed:
 *
 *     Running `set CARGO='C:\...\cargo.exe'&& set CARGO_CRATE_NAME=build_script_build&& set
 *     CARGO_MANIFEST_DIR='C:\...\crate'&& ... && set CARGO_PKG_NAME=sherpa-onnx-sys&& ...
 *
 * A parser written for the unix form sees `set` as the command, `CARGO='...&&` as a word
 * that is not an assignment, and therefore reports that cargo printed no invocation --
 * which is what it did on every Windows leg until this was fixed.
 *
 * Values arrive unquoted, because `tokenizeCargoCommand` consumes the quoted run and
 * appends its contents: `CARGO_PKG_LICENSE='MIT OR Apache-2.0'` arrives as one word with
 * the space intact and no quotes, which is what makes the two shapes compare equal.
 */
export function parseEnvPrefix(words) {
  const env = {};
  const cleaned = [];
  for (const word of words) {
    if (word === "set") continue;
    if (word === "&&") continue;
    // `CARGO='...'&&` -- the separator is glued to the assignment by `cmd` quoting rules.
    cleaned.push(word.endsWith("&&") ? word.slice(0, -2) : word);
  }
  let index = 0;
  while (
    index < cleaned.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(cleaned[index])
  ) {
    const at = cleaned[index].indexOf("=");
    const name = cleaned[index].slice(0, at);
    // No unquoting here: `tokenizeCargoCommand` consumes the quoted run and appends its
    // contents, so by this point the quotes are already gone. An earlier version carried
    // an unquote branch that could not execute, and it read as though it were what made
    // the windows form work.
    env[name] = cleaned[index].slice(at + 1);
    index += 1;
  }
  return { env, argv: cleaned.slice(index) };
}

/**
 * Picks the build script's rustc invocation out of `cargo build -vv` output.
 *
 * Exported so `sherpa-build-script-tests.test.mjs` can pin the selection rule: a
 * harness that silently picked the wrong unit would pass while compiling some
 * other crate's tests.
 */
export function findBuildScriptInvocation(verboseOutput) {
  const matches = [];
  for (const line of verboseOutput.split("\n")) {
    let words;
    try {
      words = tokenizeCargoCommand(line) ?? tokenizeCargoCommandLoose(line);
    } catch {
      continue;
    }
    if (!words) continue;
    const { env, argv } = parseEnvPrefix(words);
    if (env.CARGO_PKG_NAME !== SHERPA_PKG_NAME) continue;
    // `basename` from node:path splits on `/` only, and the program name on windows is a
    // `\`-separated absolute path, so it came back whole and matched nothing. Take the
    // last segment across both separators.
    const program = (argv[0] ?? "").split(/[/\\]/).pop();
    // `rustc.exe` on Windows: the replayed command is whatever cargo invoked there.
    if (!/^rustc(\.exe)?$/.test(program)) continue;
    const at = argv.indexOf("--crate-name");
    if (at === -1 || argv[at + 1] !== BUILD_SCRIPT_CRATE_NAME) continue;
    matches.push({ env, argv });
  }
  return matches;
}

/**
 * Rewrites cargo's build-script invocation into one that compiles
 * `build.rs` from the checkout instead of the probe copy, writing to `outBinary`.
 *
 * The dropped flags all describe the *output* cargo wanted for a different unit:
 * `--crate-type bin` (a test harness is its own crate type, and passing both is an
 * error), `--out-dir`/`--emit` (replaced by `-o`), `-C incremental=` (keyed to the
 * non-test fingerprint), `-C extra-filename=` (contradicts `-o`) and the
 * `--error-format`/`--json` pair (its JSON diagnostics are unreadable in a CI log).
 *
 * Everything that decides *what compiles against what* is kept -- `--edition`, the
 * `--extern` rlibs, the `-L dependency`/`-L native` search paths, `--cfg feature`,
 * `--check-cfg`, `--cap-lints` -- because those are the parts that go stale when
 * the build-dependency set changes.
 */
export function rewriteInvocation({ env, argv }, { outBinary, test }) {
  const droppedWithValue = new Set(["--crate-type", "--out-dir", "-o", "--emit"]);
  // `-C\s*` rather than `-C `: cargo's `-vv` output spells these JOINED
  // (`-Cincremental=...`), and a rewrite that only recognised the spaced form
  // passed `-Cincremental=<the non-test fingerprint>` straight through while also
  // appending `--test` -- the exact collision the comment above this function says
  // the flag is dropped to avoid. The spaced spelling is kept in the pattern because
  // a hand-written or older cargo may emit it, and both cost nothing to accept.
  const droppedPrefix =
    /^(?:--(?:error-format|json|emit)|-C\s*(?:incremental|extra-filename))=/;
  const out = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (droppedWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (droppedPrefix.test(arg)) continue;
    // Cargo passes the build script's source path relative to the manifest
    // directory. Point it at the file in the checkout: this harness asserts
    // something about that file, not about a copy of it.
    if (arg === "build.rs") {
      out.push(buildRs);
      continue;
    }
    out.push(arg);
  }
  if (test) out.push("--test");
  out.push("-o", outBinary);
  return { env, argv: [argv[0], ...out] };
}

/** Runs a command, capturing both streams. */
function capture(label, command, args, options) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    fail(`${label}: could not run \`${command}\`: ${result.error.message}`);
  }
  return result;
}

/**
 * Builds the patch crate with `cargo build -vv` on a copy of it, and returns the
 * verbose output plus where everything landed.
 *
 * The copy is deliberate. Building in place would write a `Cargo.lock` into
 * `patches/`; forcing cargo to reprint the command (it prints nothing for an
 * up-to-date unit) would mean `cargo clean -p` first, which destroys artifacts
 * other work in this repository depends on; and building in place would pick up
 * the parent workspace. A copy also means the probe's target directory is always
 * cold, which is what guarantees the invocation is printed at all.
 */
function probeBuild(workDir) {
  const crateDir = join(workDir, "crate");
  const targetDir = join(workDir, "target");
  mkdirSync(crateDir, { recursive: true });
  copyFileSync(manifest, join(crateDir, "Cargo.toml"));
  copyFileSync(buildRs, join(crateDir, "build.rs"));
  for (const entry of ["src", "LICENSE", "README.md"]) {
    const from = join(patchDir, entry);
    if (existsSync(from)) cpSync(from, join(crateDir, entry), { recursive: true });
  }
  // The copied crate carries no `Cargo.lock`, so cargo picks build-dependency
  // versions itself. Left to itself it takes the newest the index offers, which is
  // not necessarily what the real build uses -- and this harness compiles the build
  // script against those rlibs, so a drifted `tar` or `ureq` would mean the tests
  // ran against something the shipped build never sees. Seeding the workspace lock
  // pins them to exactly what `cargo test --locked` on the transcription package
  // resolves.
  //
  // Cargo re-resolves anyway (the lock's root package is not this one), keeping
  // every version it can. That is the point: it is a set of pins, not a lock.
  //
  // It is a preference, not a requirement. A pinned version missing from a local
  // cache fails the build outright where a fresh resolve might have succeeded, so
  // the unseeded attempt is kept as a fallback below rather than being assumed
  // equivalent.
  const seedLock = existsSync(workspaceLock);
  if (seedLock) copyFileSync(workspaceLock, join(crateDir, "Cargo.lock"));

  // Ladder of attempts, most constrained first. Each rung differs in exactly one
  // thing, so the failure that survives all of them names a single cause.
  const allowFetch = process.env.SHERPA_BUILD_SCRIPT_TESTS_ALLOW_FETCH === "1";
  const attempts = [
    { offline: true, seeded: true, note: "offline, workspace lockfile seeded" },
    { offline: true, seeded: false, note: "offline, no lockfile" },
  ];
  if (allowFetch) {
    attempts.push({ offline: false, seeded: true, note: "networked (allowed), workspace lockfile seeded" });
  }

  const failures = [];
  const homes = candidateCargoHomes();
  let home = process.env.CARGO_HOME;
  if (!hasCachedCrates(home)) {
    const found = homes.find((candidate) => hasCachedCrates(candidate));
    if (found) {
      console.log(
        `note: CARGO_HOME=${home ?? `${homedir()}/.cargo (default)`} holds no cached ` +
          `crates; using ${found} instead. Set CARGO_HOME yourself to silence this.`,
      );
      home = found;
    }
  }

  for (const attempt of attempts) {
    if (!attempt.seeded) {
      const lock = join(crateDir, "Cargo.lock");
      if (existsSync(lock)) rmSync(lock);
    }
    const result = capture(
      "cargo build -vv",
      process.env.CARGO || "cargo",
      [
        "build",
        "-vv",
        ...(attempt.offline ? ["--offline"] : []),
        "--target-dir",
        targetDir,
      ],
      {
        cwd: crateDir,
        env: {
          ...process.env,
          ...(home ? { CARGO_HOME: home } : {}),
          // `try_main` returns before reaching `download_prebuilt_libs` when this
          // is set, so a cold cache cannot turn the probe into a 22 MB download.
          DOCS_RS: "1",
        },
      },
    );
    if (result.status === 0) {
      return { output: (result.stdout ?? "") + (result.stderr ?? ""), crateDir, targetDir };
    }
    failures.push({
      note: attempt.note,
      status: result.status,
      log: (result.stdout ?? "") + (result.stderr ?? ""),
    });
  }

  fail(probeBuildFailureMessage(failures, { seedLock, homes, home }));
}

/**
 * A `CARGO_HOME` whose registry cache actually holds the build-dependencies.
 *
 * Without this the harness fails whenever it is run as a user whose `CARGO_HOME`
 * was never populated -- which is the normal case for a shell that has not
 * exported `CARGO_HOME`, because cargo then defaults to `$HOME/.cargo`. The
 * dependencies are on disk somewhere; they were fetched by whichever account ran
 * the repository's own cargo commands, and that is the cache worth using.
 *
 * Only consulted when the inherited `CARGO_HOME` has already failed, so a correct
 * environment is never second-guessed. Candidates are the current user, the owner
 * of the repository checkout, and the parent directory of a configured
 * `CARGO_TARGET_DIR` -- the last because a warm target directory implies a warm
 * cargo home next to it. Each candidate must actually contain registry `.crate`
 * files, so a directory that merely exists is not accepted.
 */
function candidateCargoHomes() {
  const candidates = [process.env.CARGO_HOME, homedir() && join(homedir(), ".cargo")];
  const targetDir = process.env.CARGO_TARGET_DIR;
  if (targetDir) {
    // A target directory is conventionally a sibling of the cargo home, or inside
    // a checkout whose owner's cargo home holds the sources that built it.
    candidates.push(join(dirname(targetDir), ".cargo"));
  }
  try {
    const stat = statSync(repoRoot);
    if (typeof stat.uid === "number") {
      const passwd = readFileSync("/etc/passwd", "utf8");
      const entry = passwd.split("\n").find((line) => line.split(":")[2] === String(stat.uid));
      if (entry) candidates.push(join("/home", entry.split(":")[0], ".cargo"));
    }
  } catch {
    // No passwd lookup, or an unreadable one: the inherited CARGO_HOME and the
    // target-dir sibling are enough, and the failure message says what to do.
  }
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * True when `home` holds at least one cached `.crate` file.
 *
 * Exported so the empty case can be pinned. The bug the guard inside fixes only appears
 * when `CARGO_HOME` is UNSET, which is the default -- and the function was module-private,
 * so nothing in the suite could reach it. Removing the guard again would have left every
 * test green, which is how it survived the first review round intact.
 */
export function hasCachedCrates(home) {
  // A falsy `home` must be false, never a probe of the relative path
  // `registry/cache`. `join("", "registry", "cache")` drops the empty first segment and
  // yields `registry/cache`, which `existsSync` resolves against `process.cwd()` -- the
  // repository root, since the harness is run from there. So a `registry/cache/<hash>/
  // *.crate` tree anywhere under the checkout reported the DEFAULT cargo home as warm, the
  // fallback candidates in `candidateCargoHomes()` were skipped, and the offline probe build
  // failed with `no matching package named bzip2 found` -- a message that points at the
  // network rather than at the probe.
  if (!home) return false;
  const registry = join(home, "registry", "cache");
  if (!existsSync(registry)) return false;
  for (const hash of readdirSync(registry)) {
    const dir = join(registry, hash);
    try {
      if (statSync(dir).isDirectory() && readdirSync(dir).some((f) => f.endsWith(".crate"))) {
        return true;
      }
    } catch {
      // Unreadable subdirectory: keep looking rather than failing the check.
    }
  }
  return false;
}

/**
 * Explains a probe build that could not resolve its build-dependencies.
 *
 * Written deliberately: the obvious reading of "no matching package named `bzip2`
 * found ... you are using offline mode" is that the network is down or the crate
 * was unpublished. Neither is usually true. This build compiles a COPY of the
 * patch crate in a temp directory, and that copy has to resolve `bzip2`, `tar`,
 * `ureq` and `sha2` from whatever registry cache the invoking environment points
 * at. A `no matching package named X found` therefore says the registry cache
 * being used has no entry for X -- which is what an empty or wrong `CARGO_HOME`
 * looks like, and it is common when the harness is run as a different user than
 * the one that populated the cache, since cargo defaults `CARGO_HOME` to
 * `$HOME/.cargo`.
 */
function probeBuildFailureMessage(failures, { seedLock, homes, home }) {
  const cargoHome = process.env.CARGO_HOME || `${homedir()}/.cargo (default)`;
  const resolutionFailure = failures.some((f) =>
    /no matching package named/.test(f.log),
  );
  const lines = [
    "could not compile the sherpa-onnx-sys build script, so its tests did not run.",
    "",
    `cargo home in use : ${home ?? cargoHome}`,
    `cargo homes tried : ${homes.join(", ") || "(none found)"}`,
    `lockfile seeded   : ${seedLock ? "yes, from packages/rust_transcription/Cargo.lock" : "no, none found in the repository"}`,
    "",
    "Attempts, in order:",
    ...failures.map((f) => `  - ${f.note}: exit ${f.status}`),
  ];
  if (resolutionFailure) {
    lines.push(
      "",
      "The failure is resolution, not availability: the registry cache cargo is",
      "reading has no index entry for the build-dependencies. This is what an empty",
      "or mismatched CARGO_HOME looks like -- cargo defaults it to $HOME/.cargo, so",
      "running this harness as a different user than the one that populated the",
      "cache resolves against a cache that was never filled. The .crate files",
      "usually ARE present, under a different CARGO_HOME.",
      "",
      "Fix: point CARGO_HOME at a cargo home that holds them, e.g.",
      "  CARGO_HOME=<path> node scripts/ci/sherpa-build-script-tests.mjs",
      "Every cargo home this harness could infer is listed above; none of them had",
      "the crates, so the registry cache has to be fetched or pointed at first --",
      "for example by running `cargo fetch` with that CARGO_HOME.",
      "In CI this step runs after the transcription package's own `cargo test",
      "--locked`, which populates the runner's default CARGO_HOME, so the offline",
      "rung is expected to succeed there. To allow a networked retry here, set",
      "SHERPA_BUILD_SCRIPT_TESTS_ALLOW_FETCH=1.",
    );
  } else {
    lines.push("", "Full output of the last attempt is below.", "", failures.at(-1).log);
  }
  return lines.join("\n");
}

/**
 * The name cargo gives the build-script binary on THIS host.
 *
 * Cargo appends the target's executable suffix, so the file on disk is
 * `build-script-build.exe` on Windows and has no suffix elsewhere. Looking for the
 * extensionless name alone made `candidates` empty on the `windows-latest` leg of
 * test-package-rust-transcription, which failed the step after doing all the cargo
 * work and before running a single test -- a green-looking job on every other
 * platform and a hard failure on one.
 */
export function buildScriptBinaryName(hostPlatform = process.platform) {
  return hostPlatform === "win32" ? "build-script-build.exe" : "build-script-build";
}

/**
 * The name the REPLAYED rustc invocation is told to write, which has to be the name this
 * host will execute.
 *
 * The same trap as `buildScriptBinaryName`, one step later. `-o` writes whatever it is
 * given, so a suffixless name produces a file Windows will not start -- and the failure
 * reads like a missing file rather than a missing extension:
 *
 *     spawnSync C:\...\sherpa-build-script-tests: ENOENT
 *
 * Exported and parameterised because nothing on Linux can observe `process.platform`
 * choosing the suffix: the name is identical here with or without it, so a test that
 * asserted the real call would pass either way.
 */
export function replayedTestBinaryName(hostPlatform = process.platform) {
  return `sherpa-build-script-tests${hostPlatform === "win32" ? ".exe" : ""}`;
}

/** The build script binary cargo actually produced, used for the marker check. */
function cargoBuildScriptBinary(targetDir, hostPlatform = process.platform) {
  const buildRoot = join(targetDir, "debug", "build");
  const names = [buildScriptBinaryName(hostPlatform), "build-script-build"]
    .filter((name, i, all) => all.indexOf(name) === i);
  const candidates = [];
  if (existsSync(buildRoot)) {
    for (const entry of readdirSync(buildRoot)) {
      if (!entry.startsWith(`${SHERPA_PKG_NAME}-`)) continue;
      for (const name of names) {
        const candidate = join(buildRoot, entry, name);
        if (existsSync(candidate)) {
          candidates.push(candidate);
          break;
        }
      }
    }
  }
  if (candidates.length !== 1) {
    fail(
      `expected exactly one ${SHERPA_PKG_NAME} build script under ${buildRoot} ` +
        `(looked for ${names.join(" and ")}), found ${candidates.length}. ` +
        `Without the binary cargo produced, this ` +
        "harness cannot check that the test-only digest override is absent from " +
        "it. Refusing to pass.",
    );
  }
  return candidates[0];
}

function runHarness(workDir) {
  const { output, crateDir, targetDir } = probeBuild(workDir);

  let matches;
  try {
    matches = findBuildScriptInvocation(output);
  } catch (err) {
    fail(`could not parse cargo's -vv output: ${err.message}`);
  }
  if (matches.length === 0) {
    // Print what cargo said. Without this the step reports "no rustc invocation" and
    // nothing else: the output is captured in a variable, so the CI log contains the
    // conclusion and none of the evidence, and the obvious next question -- what did
    // cargo 1.99 actually print -- cannot be answered from the run that failed.
    console.error(cargoOutputExcerpt(output));
    const sawAny = output.includes("Running `");
    fail(
      "cargo build -vv printed no rustc invocation for the " +
        SHERPA_PKG_NAME +
        " build script (looked for a `Running` line with CARGO_PKG_NAME=" +
        SHERPA_PKG_NAME +
        " and --crate-name " +
        BUILD_SCRIPT_CRATE_NAME +
        "). " +
        (sawAny
          ? "Other build scripts were compiled, so this is a selection failure " +
            "rather than an empty log: the matching rule in " +
            "scripts/ci/sherpa-build-script-tests.mjs has drifted from what cargo " +
            "prints."
          : "No `Running` lines at all, so cargo was not verbose. Either way this " +
            "harness must not report success when it could not find the command to " +
            "replay."),
    );
  }
  if (matches.length > 1) {
    fail(
      `found ${matches.length} rustc invocations for the ${SHERPA_PKG_NAME} build ` +
        "script; expected exactly one. Refusing to guess which to replay.",
    );
  }
  const located = matches[0];

  // The whole premise: cargo builds a build script as a plain binary and runs it.
  // If that ever stopped being true this harness would be checking the wrong
  // thing, so it says so rather than quietly compiling something else.
  const crateTypeAt = located.argv.indexOf("--crate-type");
  if (crateTypeAt === -1 || located.argv[crateTypeAt + 1] !== "bin") {
    fail(
      "the invocation cargo printed for the build script does not use " +
        "`--crate-type bin`. This harness exists because cargo builds a build " +
        "script as a plain binary and never under `--test`; if that has changed, " +
        "this harness needs revisiting rather than passing.",
    );
  }
  const sources = located.argv.filter((arg) => arg === "build.rs" || arg === buildRs);
  if (sources.length !== 1) {
    fail(
      "the invocation cargo printed names build.rs " +
        sources.length +
        " times, so the `--test` replay could not be aimed at the file in the " +
        "checkout. Refusing to pass.",
    );
  }

  // WITH the executable suffix, or the replay produces a file Windows will not run.
  //
  // This is the same trap `buildScriptBinaryName` exists for, one step later: the replayed
  // rustc writes whatever `-o` says, so the name has to be the one the host will execute.
  // Without it the Windows leg got all the way to running the tests -- 18 of them, compiled
  // from the right source with the right externs -- and then failed with
  //
  //     spawnSync C:\...\sherpa-build-script-tests: ENOENT
  //
  // which reads like a missing file and is really a missing extension.
  const testBinary = join(workDir, replayedTestBinaryName());
  const rewrite = rewriteInvocation(located, { outBinary: testBinary, test: true });
  const childEnv = { ...process.env, ...rewrite.env };

  const compiled = capture("rustc --test", rewrite.argv[0], rewrite.argv.slice(1), {
    cwd: crateDir,
    env: childEnv,
  });
  if (compiled.status !== 0) {
    fail(
      `could not compile the tests in ${buildRs} (exit ${compiled.status}). ` +
        "Diagnostics are above.\n" +
        (compiled.stdout ?? "") +
        (compiled.stderr ?? ""),
    );
  }
  // Cargo's own flags, so a warning in the build script's test module is one a
  // normal `cargo build` would never show. Left unfixed, that is how dead code in
  // these tests survives. Matched on the build script's own path rather than on the
  // word "warning", so an unrelated warning from the toolchain does not fail a run
  // over code that has nothing to do with this build script.
  const aboutBuildRs = new RegExp(`${escapeForRegExp(buildRs)}|\\bbuild\\.rs\\b`);
  const warnings = (compiled.stderr ?? "")
    .split("\n")
    .filter((line) => aboutBuildRs.test(line));
  if (warnings.length > 0) {
    fail(
      "compiling the tests in " +
        buildRs +
        " produced warnings about the build script itself:\n" +
        warnings.join("\n") +
        "\nThe build script is compiled with cargo's flags here, so these would " +
        "never show up in a normal `cargo build`.",
    );
  }

  // `download_prebuilt_libs` refuses any archive it cannot match against a pin, and
  // a test cannot produce a 22 MB official release tarball byte-for-byte, so
  // `pinned_archive_digest` carries a `cfg(test)` hook that supplies one. Cargo
  // never builds a build script under `--test`, so that hook is not supposed to be
  // in the artifact any real build runs. Checked against the binary cargo just
  // produced rather than asserted in a comment, because this is exactly the kind
  // of claim that stops being true without anything failing.
  const plainBytes = readFileSync(cargoBuildScriptBinary(targetDir));
  if (plainBytes.includes(Buffer.from(OVERRIDE_MARKER))) {
    fail(
      "the build script cargo built as a plain binary contains the test-only " +
        "pinned-digest override marker (" +
        OVERRIDE_MARKER +
        "). `#[cfg(test)]` is therefore not excluding that hook from the artifact " +
        "real builds run, and these tests would no longer be exercising the " +
        "shipped build script.",
    );
  }
  if (!readFileSync(testBinary).includes(Buffer.from(OVERRIDE_MARKER))) {
    fail(
      "the `--test` build of the build script does not contain the pinned-digest " +
        'override marker "' +
        OVERRIDE_MARKER +
        '". Either it was renamed in build.rs without updating this harness, or ' +
        "the hook it names is gone. Update both together.",
    );
  }

  // Strip CARGO_* so nothing the test binary inherits can be mistaken for the cache
  // location a wiring test sets for itself.
  const testEnv = { ...process.env };
  for (const key of Object.keys(testEnv)) {
    if (key.startsWith("CARGO_")) delete testEnv[key];
  }

  const listed = capture("test binary --list", testBinary, ["--list"], {
    cwd: crateDir,
    env: testEnv,
  });
  if (listed.status !== 0) {
    fail(
      `could not list the tests in ${buildRs} (exit ${listed.status}).\n` +
        (listed.stdout ?? "") +
        (listed.stderr ?? ""),
    );
  }
  const names = new Set(
    (listed.stdout ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/: test$/, ""))
      .filter((line) => line.startsWith("tests::")),
  );
  const missing = REQUIRED_TESTS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    fail(
      `the test binary built from ${buildRs} does not contain ${missing.length} of ` +
        `the ${REQUIRED_TESTS.length} tests this harness exists to run:\n  ` +
        missing.join("\n  ") +
        `\nIt listed ${names.size}. A green test binary that ran fewer tests than ` +
        "this asserts nothing about the code it was supposed to cover.",
    );
  }

  const result = spawnSync(testBinary, [], {
    stdio: ["ignore", "inherit", "inherit"],
    env: testEnv,
  });
  if (result.error) {
    fail(`could not run ${testBinary}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `the tests in ${buildRs} ${result.status === null ? "were killed" : `exited ${result.status}`}; ` +
        "their output is above.",
    );
  }
  console.log(
    "OK: " +
      names.size +
      " tests in " +
      buildRs +
      " -- including all " +
      REQUIRED_TESTS.length +
      " this harness names -- were compiled by replaying the rustc invocation " +
      "cargo printed for that build script with --test appended, and all of them ran.",
  );
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run the harness. Split out of the module body so importing this file for its
 * exported helpers does not compile anything.
 *
 * That is not a stylistic preference: the four exports below exist only so
 * `sherpa-build-script-tests.test.mjs` can pin the selection rule, and a test file
 * that triggers the whole cargo replay the moment it imports the module cannot test
 * anything. The top-level code used to run on import, so the test could not exist --
 * which is why these exports were documented as tested while nothing tested them.
 */
function main() {
  let exitCode = 0;
  let workDir = null;
  try {
    if (!existsSync(buildRs) || !existsSync(manifest)) {
      fail(`sherpa-onnx-sys patch crate not found at ${patchDir}`);
    }
    workDir = mkdtempSync(join(tmpdir(), "sherpa-build-script-tests-"));
    runHarness(workDir);
  } catch (err) {
    if (!(err instanceof HarnessError)) throw err;
    console.error(`::error::${err.message}`);
    exitCode = 1;
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }
  return exitCode;
}

// Only when run as a program. `node --test` imports this file, and importing it
// must not start a cargo build.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main());
}