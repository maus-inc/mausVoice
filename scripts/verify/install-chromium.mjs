#!/usr/bin/env node
/**
 * Puts a usable Chromium on this machine without a browser download host.
 *
 * The sandbox reaches `registry.npmjs.org` but not `cdn.playwright.dev`,
 * `dl.google.com` or `storage.googleapis.com`, so `playwright install` cannot
 * work here. `@sparticuz/chromium` is published on npm and carries a
 * brotli-compressed browser plus the shared libraries it needs; this script
 * unpacks those into a directory and prints how to launch them.
 *
 * It is idempotent and cheap to re-run: the output directory is wiped between
 * turns in this environment, so the reliable move is to call this again rather
 * than to keep a copy. Nothing outside the output directory is touched.
 *
 *   node scripts/verify/install-chromium.mjs [--dir /tmp/chr]
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync } from "node:zlib";

const VERSION = "153.0.0";

const argDir = process.argv.indexOf("--dir");
const OUT = argDir > -1 ? process.argv[argDir + 1] : path.join(tmpdir(), "chr");
// The package is installed outside the repository on purpose: it is a 67 MB
// browser, and a verification tool must not add that to a checkout.
const PKG_DIR = path.join(tmpdir(), "sparticuz-chromium");
/** The installed package itself, whose own manifest carries its version. */
const INSTALLED_PKG = path.join(
  PKG_DIR,
  "node_modules",
  "@sparticuz",
  "chromium",
);

const log = (message) => process.stderr.write(`${message}\n`);

const decompress = (source, destination) => {
  const data = brotliDecompressSync(readFileSyncBuffer(source));
  writeFileSync(destination, data);
  return data.length;
};

const readFileSyncBuffer = (file) =>
  execFileSync("cat", [file], { maxBuffer: 1 << 30 });

const unpackTar = (archive, into) => {
  execFileSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
};

// The extraction is built in `STAGING` and renamed onto `OUT` only once it has
// finished. Guarding on the browser binary alone was not enough: that file is
// written first, so a run interrupted while unpacking the shared libraries left
// a directory whose presence looked like success and whose contents could not
// launch. Rather than teach the guard what a complete tree contains -- a list
// that goes stale whenever the package changes -- the tree is either whole or
// absent.
// Per-process, not shared. Two verifier scripts starting cold at the same time
// both land here, and a shared staging path means each sees the other's
// half-extracted tree: the first to notice reports it as foreign and throws, so
// simultaneous cold runs failed for a reason that had nothing to do with either
// of them. The rename onto `OUT` is still atomic, so the loser of that race
// either finds a complete tree already there or replaces it wholesale.
const STAGING = `${OUT}.partial-${process.pid}`;

// Written into STAGING just before the rename, so a directory that carries it is
// one this script produced. Its absence is what lets the guard below refuse to
// delete something that is not ours.
const MARKER = ".mausvoice-chromium";

if (existsSync(path.join(OUT, "chromium"))) {
  log(`Already extracted in ${OUT}. Delete it to force a fresh extraction.`);
} else {
  // Only an extraction of ours is safe to delete. `--dir` is caller-supplied, so
  // `rmSync(OUT, { recursive: true })` on a mistyped or shared path destroys
  // whatever is there: a directory with no `chromium` in it is not evidence that
  // it is ours to remove. The marker is written only after a successful rename,
  // and STAGING is always ours.
  if (existsSync(OUT) && readdirSync(OUT).length > 0) {
    if (!existsSync(path.join(OUT, MARKER))) {
      throw new Error(
        `${OUT} is not empty and has no ${MARKER}, so it is not an extraction this script made. ` +
          `Remove it yourself, or pass a different --dir.`,
      );
    }
    rmSync(OUT, { recursive: true, force: true });
  }
  // `STAGING` is `OUT.partial-<pid>`, and `OUT` is caller-supplied, so this is a
  // recursive delete of a path the caller chose one suffix away from. A `--dir`
  // of `/tmp/work` makes this `/tmp/work.partial`, which may well be somebody
  // else's directory. The same rule the guard above applies to `OUT` applies
  // here: only remove it if it is ours, meaning empty or carrying our marker.
  //
  // Stale partials from earlier runs are swept first.
  //
  // The pid suffix keeps two concurrent runs from colliding, but it also means a
  // run that died leaves `${OUT}.partial-<its pid>`, which this run never touches
  // and nothing ever removes. On a persistent `--dir` those accumulate, one full
  // copy of the browser each. Only directories carrying the marker are removed:
  // the marker is written before extraction begins, so it means "this script
  // created this", not "this extraction finished", and an unmarked directory is
  // left alone exactly as the guard below leaves it.
  for (const sibling of readdirSync(path.dirname(OUT))) {
    if (!sibling.startsWith(`${path.basename(OUT)}.partial-`)) continue;
    const stale = path.join(path.dirname(OUT), sibling);
    if (stale === STAGING) continue;
    if (!existsSync(path.join(stale, MARKER))) continue;
    log(`  removing a partial extraction left by an earlier run: ${sibling}`);
    rmSync(stale, { recursive: true, force: true });
  }

  if (existsSync(STAGING)) {
    const ours =
      readdirSync(STAGING).length === 0 ||
      existsSync(path.join(STAGING, MARKER));
    if (!ours) {
      throw new Error(
        `${STAGING} is not empty and has no ${MARKER}, so it is not an extraction this script made. ` +
          `Remove it yourself, or pass a different --dir.`,
      );
    }
    rmSync(STAGING, { recursive: true, force: true });
  }
  mkdirSync(STAGING, { recursive: true });

  // The cache is ours by construction: `PKG_DIR` lives inside `CHR_DIR`, which is
  // this script's own directory, not a caller-chosen one. Guarded anyway, and on
  // the same rule as above, because a recursive delete is a recursive delete.
  if (existsSync(PKG_DIR) && !existsSync(path.join(PKG_DIR, MARKER))) {
    const contents = readdirSync(PKG_DIR);
    if (contents.length > 0) {
      throw new Error(
        `${PKG_DIR} is not empty and has no ${MARKER}, so it was not created by this script. ` +
          `Remove it yourself.`,
      );
    }
  }

  // The installed version, not the version some manifest *asks for*. Those are
  // different facts, and reading the declaration was wrong in a way that only
  // shows up on a stale cache: `PKG_DIR/package.json`'s dependency range is what
  // the last install requested, so a cache left behind at an older version still
  // declares the new one and passes the check, and the stale browser is then
  // extracted and reported as a success. The installed package's own manifest is
  // the only thing that knows what is actually on disk.
  const cachedVersion = (() => {
    try {
      const installed = JSON.parse(
        readFileSync(path.join(INSTALLED_PKG, "package.json"), "utf8"),
      );
      return installed.version ?? null;
    } catch {
      return null;
    }
  })();

  if (cachedVersion !== VERSION) {
    log(`Installing @sparticuz/chromium@${VERSION} into ${PKG_DIR} …`);
    rmSync(PKG_DIR, { recursive: true, force: true });
    mkdirSync(PKG_DIR, { recursive: true });
    // npm, not pnpm: this tree must not join the workspace or the lockfile.
    //
    // Bounded, and npm's own retries are off. Unbounded, a registry that accepts
    // the connection and then stalls holds the script forever with no output,
    // which reads as a hang in the verification run rather than a network fault.
    try {
      execFileSync(
        "npm",
        [
          "install",
          "--no-save",
          "--no-audit",
          "--no-fund",
          "--fetch-retries=1",
          "--fetch-timeout=60000",
          `@sparticuz/chromium@${VERSION}`,
        ],
        { cwd: PKG_DIR, stdio: "inherit", timeout: 300_000 },
      );
    } catch (error) {
      throw new Error(
        `could not install @sparticuz/chromium@${VERSION} within 5 minutes: ${error}`,
      );
    }
    // Claim the directory, so a later run can tell it apart from someone else's.
    writeFileSync(path.join(PKG_DIR, MARKER), `${VERSION}\n`);
  }

  // Resolved through the package directory rather than through
  // `require.resolve("@sparticuz/chromium/package.json")`, which its `exports`
  // map refuses.
  const pkgRoot = path.join(PKG_DIR, "node_modules", "@sparticuz", "chromium");
  if (!existsSync(pkgRoot)) throw new Error(`package not found at ${pkgRoot}`);
  const binDir = path.join(pkgRoot, "bin");
  const libDir = path.join(STAGING, "lib");
  mkdirSync(libDir, { recursive: true });

  // Claimed before anything is extracted, not after. `unpackTar` and the
  // decompressions below can fail part-way, and a failure leaves `STAGING` with
  // files in it; the guard at the top of this file refuses to delete a non-empty
  // staging directory that carries no marker, so the *next* run would refuse the
  // wrecks of its own last attempt and demand manual cleanup. Claiming first
  // means a failed run leaves something the next run is allowed to remove.
  writeFileSync(path.join(STAGING, MARKER), `${VERSION}\n`);

  log("Extracting the browser …");
  const browserBytes = decompress(
    path.join(binDir, "chromium.br"),
    path.join(STAGING, "chromium"),
  );
  chmodSync(path.join(STAGING, "chromium"), 0o755);
  log(`  chromium ${browserBytes} bytes`);

  // Without these the browser aborts before it can report a version: the AL2023
  // build links against libraries a Debian image does not carry at the same
  // soname.
  for (const name of ["al2023.tar.br", "swiftshader.tar.br", "fonts.tar.br"]) {
    const source = path.join(binDir, name);
    if (!existsSync(source)) continue;
    const tar = path.join(STAGING, name.replace(/\.br$/, ""));
    decompress(source, tar);
    unpackTar(tar, STAGING);
    rmSync(tar, { force: true });
  }

  // al2023 extracts its libraries to the archive root; put them where the
  // launcher's LD_LIBRARY_PATH expects them.
  for (const entry of readdirSync(STAGING)) {
    if (entry.endsWith(".so") || /\.so\.\d+/.test(entry)) {
      copyFileSync(path.join(STAGING, entry), path.join(libDir, entry));
    }
  }
  log(`  ${readdirSync(libDir).length} shared libraries`);

  // Whole or absent: the rename is the only thing that makes this a success.
  // The marker is already there -- it was written above, before the extraction --
  // so this only refreshes the version it records.
  writeFileSync(path.join(STAGING, MARKER), `${VERSION}\n`);
  renameSync(STAGING, OUT);
}

export const LAUNCH_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--no-zygote",
  "--single-process",
  "--disable-dev-shm-usage",
];

const version = execFileSync(path.join(OUT, "chromium"), ["--version"], {
  env: { ...process.env, LD_LIBRARY_PATH: `${path.join(OUT, "lib")}:${OUT}` },
  encoding: "utf8",
}).trim();

log(`\n${version}`);
log(`CHROMIUM_PATH=${path.join(OUT, "chromium")}`);
log(`LD_LIBRARY_PATH=${path.join(OUT, "lib")}:${OUT}`);
log(`\nLaunch flags: ${LAUNCH_FLAGS.join(" ")}`);
