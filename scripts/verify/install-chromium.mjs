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
 * than to keep a copy. Installs use a private staging directory beside the
 * output and npm may reuse its own download cache.
 *
 *   node scripts/verify/install-chromium.mjs [--dir /tmp/chr]
 */
import { CHROMIUM_LAUNCH_FLAGS } from "./browser-config.mjs";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
const OUT = path.resolve(
  argDir > -1 ? process.argv[argDir + 1] : path.join(tmpdir(), "chr"),
);

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

const log = (message) => process.stderr.write(`${message}\n`);

const decompress = (source, destination) => {
  const data = brotliDecompressSync(readFileSync(source));
  writeFileSync(destination, data);
  return data.length;
};

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

// PID liveness is meaningful only in the same boot and PID namespace. The
// time namespace must also match before comparing Linux process start ticks.
// Reject a /proc mount that sees us from an ancestor PID namespace.
function localOwnerScope() {
  if (process.platform !== "linux") return null;
  try {
    const status = readFileSync("/proc/self/status", "utf8");
    if (!new RegExp(`^NSpid:[ \t]+${process.pid}$`, "m").test(status))
      return null;
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidNamespace = readlinkSync("/proc/self/ns/pid");
    const timeNamespace = readlinkSync("/proc/self/ns/time");
    if (!boot || !pidNamespace || !timeNamespace) return null;
    return `${boot} ${pidNamespace} ${timeNamespace}`;
  } catch {
    return null;
  }
}

function recordedOwnerScope(markerPath) {
  try {
    if (!lstatSync(markerPath).isFile()) return null;
    return readFileSync(markerPath, "utf8").split("\n")[1] || null;
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
  // it is ours to remove. The marker is written into staging before publication.
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
  const scope = localOwnerScope();
  for (const sibling of readdirSync(parent)) {
    if (!sibling.startsWith(prefix)) continue;
    const suffix = sibling.slice(prefix.length);
    const stale = path.join(parent, sibling);
    const markerPath = path.join(stale, MARKER);
    if (!existsSync(markerPath)) continue;
    if (/^[1-9]\d*$/.test(suffix)) {
      // The old format cannot establish the owner’s host or PID namespace.
      // In a shared --dir, ESRCH is not evidence that this owner stopped.
      log(
        `  leaving legacy staging directory ${stale}; remove it when no installer is using it`,
      );
      continue;
    }
    const owner = /^([1-9]\d*)-(\d+|unknown)-[a-zA-Z0-9]{6}$/.exec(suffix);
    if (!owner) continue;
    if (!scope || recordedOwnerScope(markerPath) !== scope) {
      log(
        `  leaving staging directory ${stale}; owner scope is unverified, remove it only when no installer is using it`,
      );
      continue;
    }
    const pid = Number(owner[1]);
    if (pid > 0x7fffffff || !ownerExited(pid, owner[2])) continue;
    log(`  removing a partial extraction left by an earlier run: ${sibling}`);
    rmSync(stale, { recursive: true, force: true });
  }

  const STAGING = mkdtempSync(
    path.join(
      parent,
      `${prefix}${process.pid}-${processStart(process.pid) ?? "unknown"}-`,
    ),
  );
  // The marker records ownership, not extraction completion. The sweep must
  // verify the namespace and that this exact owner has exited before reclaiming it.
  writeFileSync(path.join(STAGING, MARKER), `${VERSION}\n${scope ?? ""}\n`);

  try {
    const packageDir = path.join(STAGING, "npm-package");
    const binDir = installChromiumPackage(packageDir);
    extractBrowser(binDir, STAGING);
    rmSync(packageDir, { recursive: true });

    // Rename only after every file is ready. A concurrent complete publish
    // wins; callers never launch a tree that another installer is mutating.
    try {
      renameSync(STAGING, OUT);
    } catch (error) {
      if (!isPublishedInstall(OUT)) throw error;
      log(`  another run published ${OUT} first; using it`);
    }
  } finally {
    // This path belongs to this attempt alone, even if npm timed out midway.
    rmSync(STAGING, { recursive: true, force: true });
  }
}

function installChromiumPackage(packageDir) {
  mkdirSync(packageDir);
  // npm refuses to install into a directory it does not recognise as a project:
  // with no manifest it reports "up to date", writes nothing, and the extraction
  // then fails on a package that was never unpacked. The manifest is npm's own,
  // not the browser's, so it is written here and removed with the staging tree.
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "chromium-staging", private: true }, null, 2),
  );
  log(`Installing @sparticuz/chromium@${VERSION} …`);
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
      {
        cwd: packageDir,
        stdio: "inherit",
        timeout: 300_000,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    throw new Error(
      `could not install @sparticuz/chromium@${VERSION}: ${error}`,
    );
  }
  const pkgRoot = path.join(
    packageDir,
    "node_modules",
    "@sparticuz",
    "chromium",
  );
  const { version } = JSON.parse(
    readFileSync(path.join(pkgRoot, "package.json"), "utf8"),
  );
  if (version !== VERSION) {
    throw new Error(
      `installed chromium package is ${version}, expected ${VERSION}`,
    );
  }
  return path.join(pkgRoot, "bin");
}

function extractBrowser(binDir, staging) {
  const libDir = path.join(staging, "lib");
  mkdirSync(libDir, { recursive: true });

  log("Extracting the browser …");
  const browserBytes = decompress(
    path.join(binDir, "chromium.br"),
    path.join(staging, "chromium"),
  );
  chmodSync(path.join(staging, "chromium"), 0o755);
  log(`  chromium ${browserBytes} bytes`);

  // Without these the browser aborts before it can report a version: the AL2023
  // build links against libraries a Debian image does not carry at the same
  // soname.
  for (const name of ["al2023.tar.br", "swiftshader.tar.br", "fonts.tar.br"]) {
    const source = path.join(binDir, name);
    if (!existsSync(source)) continue;
    const tar = path.join(staging, name.replace(/\.br$/, ""));
    decompress(source, tar);
    unpackTar(tar, staging);
    rmSync(tar, { force: true });
  }

  // al2023 extracts its libraries to the archive root; put them where the
  // launcher's LD_LIBRARY_PATH expects them.
  for (const entry of readdirSync(staging)) {
    if (entry.endsWith(".so") || /\.so\.\d+/.test(entry)) {
      copyFileSync(path.join(staging, entry), path.join(libDir, entry));
    }
  }
  log(`  ${readdirSync(libDir).length} shared libraries`);
}

const version = execFileSync(path.join(OUT, "chromium"), ["--version"], {
  env: { ...process.env, LD_LIBRARY_PATH: `${path.join(OUT, "lib")}:${OUT}` },
  encoding: "utf8",
}).trim();

log(`\n${version}`);
log(`CHROMIUM_PATH=${path.join(OUT, "chromium")}`);
log(`LD_LIBRARY_PATH=${path.join(OUT, "lib")}:${OUT}`);
log(`\nLaunch flags: ${CHROMIUM_LAUNCH_FLAGS.join(" ")}`);
