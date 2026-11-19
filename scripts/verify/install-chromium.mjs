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
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
/**
 * Whether `dir` holds a usable published browser, not just a directory.
 *
 * Checked before accepting a concurrent winner: the claim being made is "the
 * browser this run wanted is already there", and the marker alone cannot make it
 * -- a tree carrying the marker but no executable is a half-written publish, and
 * treating it as a win would send the caller to spawn a file that is not there.
 */
function isPublishedInstall(dir) {
  return existsSync(path.join(dir, MARKER)) && hasBrowser(dir);
}

function hasBrowser(dir) {
  try {
    const binary = statSync(path.join(dir, "chromium"));
    return binary.isFile() && binary.size > 0;
  } catch {
    return false;
  }
}

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
// Each attempt gets a unique staging path. A recycled PID must not reuse a
// name another installer may have just decided to sweep.
// Written before extraction so owned partials can be identified after a crash.
const MARKER = ".mausvoice-chromium";

// Linux reports when this particular process started. `comm` may contain
// spaces or parentheses, so start parsing after its closing parenthesis.
function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function ownerExited(pid, startedAt) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH";
  }
  const currentStart = processStart(pid);
  return (
    startedAt !== "unknown" &&
    currentStart !== null &&
    currentStart !== startedAt
  );
}

if (hasBrowser(OUT)) {
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
  // Only sweep marked, uniquely named attempts. A live PID alone is not
  // evidence of ownership if Linux reports a different process start time.
  const parent = path.dirname(OUT);
  const prefix = `${path.basename(OUT)}.partial-`;
  mkdirSync(parent, { recursive: true });
  for (const sibling of readdirSync(parent)) {
    if (!sibling.startsWith(prefix)) continue;
    const owner = /^([1-9]\d*)-(\d+|unknown)-[a-zA-Z0-9]{6}$/.exec(
      sibling.slice(prefix.length),
    );
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (pid > 0x7fffffff) continue;
    const stale = path.join(parent, sibling);
    if (!existsSync(path.join(stale, MARKER)) || !ownerExited(pid, owner[2]))
      continue;
    log(`  removing a partial extraction left by an earlier run: ${sibling}`);
    rmSync(stale, { recursive: true, force: true });
  }

  const STAGING = mkdtempSync(
    `${OUT}.partial-${process.pid}-${processStart(process.pid) ?? "unknown"}-`,
  );

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
  // A concurrent winner is a success, not a failure.
  //
  // Two processes can both see `OUT` absent and both extract; the unique
  // staging directory is what lets them get this far without colliding. The first
  // rename publishes its tree, and the second then fails with ENOTEMPTY, because
  // `rename` onto an existing non-empty directory is an error rather than a
  // replace. That is not a fault in this run: the browser it wanted is on disk.
  try {
    renameSync(STAGING, OUT);
  } catch (error) {
    if (!isPublishedInstall(OUT)) {
      // Anything else is a real failure, and the staging directory is left in
      // place because it may be the only complete copy.
      throw error;
    }
    log(`  another run published ${OUT} first; using it`);
    rmSync(STAGING, { recursive: true, force: true });
  }
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
