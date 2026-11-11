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
const STAGING = `${OUT}.partial`;

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
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });

  if (!existsSync(path.join(PKG_DIR, "package.json"))) {
    log(`Installing @sparticuz/chromium@${VERSION} into ${PKG_DIR} …`);
    rmSync(PKG_DIR, { recursive: true, force: true });
    mkdirSync(PKG_DIR, { recursive: true });
    // npm, not pnpm: this tree must not join the workspace or the lockfile.
    execFileSync(
      "npm",
      [
        "install",
        "--no-save",
        "--no-audit",
        "--no-fund",
        `@sparticuz/chromium@${VERSION}`,
      ],
      { cwd: PKG_DIR, stdio: "inherit" },
    );
  }

  // Resolved through the package directory rather than through
  // `require.resolve("@sparticuz/chromium/package.json")`, which its `exports`
  // map refuses.
  const pkgRoot = path.join(PKG_DIR, "node_modules", "@sparticuz", "chromium");
  if (!existsSync(pkgRoot)) throw new Error(`package not found at ${pkgRoot}`);
  const binDir = path.join(pkgRoot, "bin");
  const libDir = path.join(STAGING, "lib");
  mkdirSync(libDir, { recursive: true });

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
