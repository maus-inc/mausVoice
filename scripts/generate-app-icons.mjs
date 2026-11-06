#!/usr/bin/env node
/**
 * Regenerate every packaged app icon from the branding master.
 *
 * Why this script exists
 * ---------------------
 * The "black background in the taskbar" report had two distinct causes, and
 * only one of them was about transparency:
 *
 *  1. **Flattened alpha.** The previously committed `icon.ico` frames were
 *     fully opaque (`alpha = 1` at the corners). The branding master is a dark
 *     rounded tile whose *corners* are transparent, so flattening turned the
 *     rounded tile into a hard black square. That is the black background the
 *     user sees. The artwork itself is intentionally a dark tile — the fix is
 *     to preserve its alpha, not to strip the tile.
 *
 *  2. **A single-resolution ICO.** A later regeneration produced an `icon.ico`
 *     containing only one 16x16 frame (852 bytes). Windows picks a 32/48/256px
 *     frame for the taskbar, Alt-Tab and Explorer; with only 16x16 available it
 *     upscales that frame, or falls back to a cached icon, so the icon appears
 *     unchanged and blurry.
 *
 *  3. **A fake ICNS.** ImageMagick has no working ICNS encoder - handed a frame
 *     list it silently writes the first frame as a bare PNG under an `.icns`
 *     name. The committed `icon.icns` was a 1.2 KB 16x16 PNG, so macOS upscaled
 *     16x16 into the Dock, Finder and Alt-Tab. The container is now assembled
 *     directly (see `writeIcns`).
 *
 * This script writes every size referenced by `tauri.conf.json` with alpha
 * preserved end to end, emits a genuine multi-resolution `.ico`, and then
 * verifies both properties so neither regression can land again.
 *
 * Usage:
 *   node scripts/generate-app-icons.mjs           # regenerate all icons
 *   node scripts/generate-app-icons.mjs --check   # verify only (CI-friendly)
 *
 * Requires ImageMagick. The binary is resolved from a fixed list of trusted
 * system directories rather than `$PATH`; override with an absolute path via
 * `IMAGEMAGICK_CONVERT` if it lives elsewhere.
 *
 * Windows note: this script only searches POSIX-style installation directories.
 * Windows maintainers must set the `IMAGEMAGICK_CONVERT` environment variable
 * to an absolute path (e.g., `C:\Program Files\ImageMagick-7.1.0-Q16\magick.exe`)
 * before running the script.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveConvertBinary } from "./imagemagick-resolution.mjs";
import { withTemporaryIconFiles } from "./icon-temporary-files.mjs";
import { fileURLToPath } from "node:url";
import {
  parseIcoFrames,
  parseIcnsFrames,
  checkIcoFrameSizes,
  checkIcnsFrameSizes,
  parseCornerAlpha,
} from "./app-icon-containers.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to the ImageMagick binary, resolved once at startup. */
let convertBin = null;

/**
 * Branding master: a 1024x1024 dark rounded tile with the mausVoice wordmark.
 * Its corners are transparent, and every generated icon must keep them so.
 */
const MASTER = join(repoRoot, "branding", "mausvoice-logo-1024.png");

const desktopIcons = join(repoRoot, "apps/desktop/src-tauri/icons");
const installerIcons = join(repoRoot, "apps/windows-installer/src-tauri/icons");
const publicDir = join(repoRoot, "apps/desktop/public");

/** Square PNGs written to the desktop icon directory. */
const DESKTOP_PNGS = {
  "32x32.png": 32,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
  "windows-icon.png": 128,
  "StoreLogo.png": 50,
  "Square30x30Logo.png": 30,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square89x89Logo.png": 89,
  "Square107x107Logo.png": 107,
  "Square142x142Logo.png": 142,
  "Square150x150Logo.png": 150,
  "Square284x284Logo.png": 284,
  "Square310x310Logo.png": 310,
  "Square30x30.png": 30,
  "Square44x44.png": 44,
  "Square71x71.png": 71,
  "Square89x89.png": 89,
  "Square107x107.png": 107,
  "Square142x142.png": 142,
  "Square150x150.png": 150,
  "Square284x284.png": 284,
  "Square310x310.png": 310,
};

const INSTALLER_PNGS = {
  "32x32.png": 32,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "icon.png": 512,
};

/**
 * Frames embedded in `icon.ico`. Windows selects per surface: 16 for the window
 * caption, 32/48 for the taskbar and Alt-Tab, 256 for Explorer's extra-large
 * view. Shipping fewer forces the shell to upscale a small frame.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * Frames embedded in `icon.icns`, mirroring what `iconutil` emits from a
 * complete `.iconset`. macOS picks per surface: the Dock renders 512/1024,
 * Finder 128/256, Alt-Tab 256, the Get Info header 512.
 *
 * Several sizes appear twice on purpose. A 32px frame serves both the 32pt
 * standard slot (`icp5`) and the 16pt @2x slot (`ic11`); macOS resolves the
 * Retina slots by chunk type, not by pixel size, so omitting the `ic1x` types
 * makes it fall back to scaling a different frame.
 */
const ICNS_FRAMES = [
  { type: "icp4", size: 16 },
  { type: "icp5", size: 32 },
  { type: "ic11", size: 32 },
  { type: "icp6", size: 64 },
  { type: "ic12", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic13", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic14", size: 512 },
  { type: "ic10", size: 1024 },
];

/** The distinct pixel sizes the ICNS frames are rendered at. */
const ICNS_SIZES = [...new Set(ICNS_FRAMES.map((frame) => frame.size))];

/** Runs ImageMagick with the given args; returns its stdout. */
function convert(args) {
  return execFileSync(convertBin, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/** Resolve the binary and confirm it actually runs before doing any work. */
function assertImageMagick() {
  convertBin = resolveConvertBinary();
  try {
    execFileSync(convertBin, ["-version"], { stdio: "ignore" });
  } catch (err) {
    throw new Error(
      `Found ${convertBin}, but it failed to run: ${err.message}`,
    );
  }
}

/**
 * Resize the master to `size`px, preserving the alpha channel.
 *
 * `-background none` plus `PNG32:` is the important part: it stops ImageMagick
 * from compositing onto an opaque canvas (which is what previously baked the
 * black square in) and forces a true 32-bit RGBA result rather than a palette.
 */
function renderSquare(size, outPath) {
  convert([
    MASTER,
    "-resize",
    `${size}x${size}`,
    "-background",
    "none",
    "-gravity",
    "center",
    "-extent",
    `${size}x${size}`,
    "-alpha",
    "on",
    `PNG32:${outPath}`,
  ]);
}

/**
 * Assemble a real ICNS container.
 *
 * ImageMagick has no usable ICNS encoder: handed a list of frames it silently
 * writes the *first* one as a bare PNG under an `.icns` name. That is exactly
 * what shipped - a 1.2 KB 16x16 PNG - so macOS had a single tiny frame to
 * upscale everywhere, which is the blurry Dock/Finder/Alt-Tab icon.
 *
 * The container is therefore assembled here: the `icns` magic, a big-endian
 * total length, then one chunk per frame (4-byte type, 4-byte length including
 * the header, PNG payload). This is the same layout `iconutil` produces.
 */
function writeIcns(framePathBySize, outPath) {
  const chunks = ICNS_FRAMES.map(({ type, size }) => {
    const png = readFileSync(framePathBySize.get(size));
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  writeFileSync(outPath, Buffer.concat([header, body]));
}

/**
 * Corner alpha tolerance.
 *
 * A correctly generated corner is 0, but the smallest frames pick up a little
 * antialiasing from the downscale (16x16 lands around 0.02). A flattened,
 * black-square icon reads 1.0, so anything below this is comfortably safe
 * while still catching the regression.
 */
const CORNER_ALPHA_TOLERANCE = 0.15;

/** Alpha of the top-left pixel, which sits in the tile's rounded corner. */
function cornerAlpha(imageSpec) {
  const out = execFileSync(
    convertBin,
    [imageSpec, "-alpha", "on", "-format", "%[fx:p{0,0}.a]", "info:"],
    { encoding: "utf8" },
  );
  return parseCornerAlpha(out, imageSpec);
}

/** True when a corner pixel is opaque enough to look like a black square. */
function isCornerOpaque(alpha) {
  return alpha > CORNER_ALPHA_TOLERANCE;
}

/**
 * Regression guard for the original bug: an opaque corner means the rounded
 * tile was flattened into a black square.
 */
function checkIcoFrameAlpha(ico, frames) {
  const problems = [];
  for (let i = 0; i < frames.length; i += 1) {
    if (isCornerOpaque(cornerAlpha(`${ico}[${i}]`))) {
      problems.push(
        `${ico}: frame ${frames[i].width}x${frames[i].height} has an opaque corner; the icon would render as a black square`,
      );
    }
  }
  return problems;
}

/** Validate one directory's icon.ico (frame sizes, bpp, corner alpha). */
function checkIco(dir) {
  const ico = join(dir, "icon.ico");
  if (!existsSync(ico)) {
    return [`missing ${ico}`];
  }
  let frames;
  try {
    frames = parseIcoFrames(readFileSync(ico), ico);
  } catch (err) {
    return [err.message];
  }
  return [
    ...checkIcoFrameSizes(ico, frames, ICO_SIZES),
    ...checkIcoFrameAlpha(ico, frames),
  ];
}

/**
 * Validate `icon.icns`: a real container, every expected chunk type present,
 * and each frame carrying a PNG at the pixel size that chunk type promises.
 */
function checkIcns(dir) {
  const icns = join(dir, "icon.icns");
  if (!existsSync(icns)) {
    return [`missing ${icns}`];
  }

  let frames;
  try {
    frames = parseIcnsFrames(readFileSync(icns), icns);
  } catch (err) {
    return [err.message];
  }

  return checkIcnsFrameSizes(icns, frames, ICNS_FRAMES);
}

/** Validate a representative sample of the generated PNGs. */
function checkPng(name) {
  const path = join(desktopIcons, name);
  if (!existsSync(path)) {
    return [`missing ${path}`];
  }
  return isCornerOpaque(cornerAlpha(path)) ? [`${path}: opaque corner`] : [];
}

/** Runs every validation pass; returns the list of problems (empty = ok). */
function verify() {
  return [
    ...[desktopIcons, installerIcons].flatMap(checkIco),
    ...checkIcns(desktopIcons),
    ...["icon.png", "32x32.png", "128x128.png"].flatMap(checkPng),
  ];
}

/** Render every packaged size from the branding master. */
function generateIcons() {
  if (!existsSync(MASTER)) {
    throw new Error(`Branding master not found: ${MASTER}`);
  }

  mkdirSync(desktopIcons, { recursive: true });
  mkdirSync(installerIcons, { recursive: true });

  for (const [name, size] of Object.entries(DESKTOP_PNGS)) {
    renderSquare(size, join(desktopIcons, name));
  }
  console.log(`Wrote ${Object.keys(DESKTOP_PNGS).length} desktop PNGs`);

  for (const [name, size] of Object.entries(INSTALLER_PNGS)) {
    renderSquare(size, join(installerIcons, name));
  }
  console.log(`Wrote ${Object.keys(INSTALLER_PNGS).length} installer PNGs`);

  // Render each ICO/ICNS frame at its native size rather than letting the
  // encoder downscale one source, so the small frames stay legible.
  withTemporaryIconFiles((track) => {
    const icoFrames = ICO_SIZES.map((size) => {
      const p = track(join(desktopIcons, `.tmp-ico-${size}.png`));
      renderSquare(size, p);
      return p;
    });
    convert([...icoFrames, join(desktopIcons, "icon.ico")]);
    convert([...icoFrames, join(installerIcons, "icon.ico")]);
    console.log(`Wrote icon.ico (${ICO_SIZES.join(", ")})`);

    const icnsFrames = new Map(
      ICNS_SIZES.map((size) => {
        const p = track(join(desktopIcons, `.tmp-icns-${size}.png`));
        renderSquare(size, p);
        return [size, p];
      }),
    );
    writeIcns(icnsFrames, join(desktopIcons, "icon.icns"));
    console.log(
      `Wrote icon.icns (${ICNS_FRAMES.length} frames: ${ICNS_SIZES.join(", ")})`,
    );

    renderSquare(512, join(publicDir, "app-icon.png"));
    renderSquare(512, join(publicDir, "app-icon-512.png"));
    console.log("Wrote public app icons");
  });
}

/** Verify every output and fail closed when any container is invalid. */
function requireValidIcons(failureTitle, successMessage) {
  const problems = verify();
  if (problems.length > 0) {
    console.error(failureTitle);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(successMessage);
}

/** Regenerate assets, or verify the existing ones with --check. */
function main() {
  assertImageMagick();
  if (process.argv.includes("--check")) {
    requireValidIcons(
      "App icon verification failed:",
      "App icons OK: alpha preserved, every required ICO frame present, " +
        "and icon.icns is a real multi-resolution container.",
    );
    return;
  }
  generateIcons();
  requireValidIcons(
    "\nGenerated icons failed verification:",
    "\nAll icons regenerated and verified.",
  );
}

main();
