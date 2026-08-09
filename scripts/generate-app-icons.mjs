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
 * This script writes every size referenced by `tauri.conf.json` with alpha
 * preserved end to end, emits a genuine multi-resolution `.ico`, and then
 * verifies both properties so neither regression can land again.
 *
 * Usage:
 *   node scripts/generate-app-icons.mjs           # regenerate all icons
 *   node scripts/generate-app-icons.mjs --check   # verify only (CI-friendly)
 *
 * Requires ImageMagick (`convert`) on PATH.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/** Frames embedded in `icon.icns` for macOS. */
const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

function convert(args) {
  return execFileSync("convert", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function assertImageMagick() {
  try {
    execFileSync("convert", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "ImageMagick (`convert`) is required. Install it and re-run:\n" +
        "  macOS:  brew install imagemagick\n" +
        "  Ubuntu: sudo apt-get install imagemagick",
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

/** Parse an ICO directory so the frame list can be asserted. */
function readIcoFrames(path) {
  const data = readFileSync(path);
  if (
    data.length < 6 ||
    data.readUInt16LE(0) !== 0 ||
    data.readUInt16LE(2) !== 1
  ) {
    throw new Error(`${path} is not a valid ICO file`);
  }
  const count = data.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    frames.push({
      width: data[entry] === 0 ? 256 : data[entry],
      height: data[entry + 1] === 0 ? 256 : data[entry + 1],
      bpp: data.readUInt16LE(entry + 6),
    });
  }
  return frames;
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
    "convert",
    [imageSpec, "-alpha", "on", "-format", "%[fx:p{0,0}.a]", "info:"],
    { encoding: "utf8" },
  );
  return Number.parseFloat(out.trim());
}

function verify() {
  const problems = [];

  for (const dir of [desktopIcons, installerIcons]) {
    const ico = join(dir, "icon.ico");
    if (!existsSync(ico)) {
      problems.push(`missing ${ico}`);
      continue;
    }

    const frames = readIcoFrames(ico);
    const widths = new Set(frames.map((f) => f.width));
    for (const size of ICO_SIZES) {
      if (!widths.has(size)) {
        problems.push(`${ico}: missing a ${size}x${size} frame`);
      }
    }
    for (const frame of frames) {
      if (frame.bpp !== 32) {
        problems.push(
          `${ico}: frame ${frame.width}x${frame.height} is ${frame.bpp}bpp, need 32bpp for alpha`,
        );
      }
    }

    // Regression guard for the original bug: an opaque corner means the
    // rounded tile was flattened into a black square.
    for (let i = 0; i < frames.length; i += 1) {
      const alpha = cornerAlpha(`${ico}[${i}]`);
      if (Number.isFinite(alpha) && alpha > CORNER_ALPHA_TOLERANCE) {
        problems.push(
          `${ico}: frame ${frames[i].width}x${frames[i].height} has an opaque corner (alpha=${alpha}); the icon would render as a black square`,
        );
      }
    }
  }

  for (const png of ["icon.png", "32x32.png", "128x128.png"]) {
    const path = join(desktopIcons, png);
    if (!existsSync(path)) {
      problems.push(`missing ${path}`);
      continue;
    }
    const alpha = cornerAlpha(path);
    if (Number.isFinite(alpha) && alpha > CORNER_ALPHA_TOLERANCE) {
      problems.push(`${path}: opaque corner (alpha=${alpha})`);
    }
  }

  return problems;
}

function main() {
  assertImageMagick();

  if (process.argv.includes("--check")) {
    const problems = verify();
    if (problems.length > 0) {
      console.error("App icon verification failed:");
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(
      "App icons OK: alpha preserved and every required ICO frame present.",
    );
    return;
  }

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
  const tmp = [];
  const icoFrames = ICO_SIZES.map((size) => {
    const p = join(desktopIcons, `.tmp-ico-${size}.png`);
    renderSquare(size, p);
    tmp.push(p);
    return p;
  });
  convert([...icoFrames, join(desktopIcons, "icon.ico")]);
  convert([...icoFrames, join(installerIcons, "icon.ico")]);
  console.log(`Wrote icon.ico (${ICO_SIZES.join(", ")})`);

  const icnsFrames = ICNS_SIZES.map((size) => {
    const p = join(desktopIcons, `.tmp-icns-${size}.png`);
    renderSquare(size, p);
    tmp.push(p);
    return p;
  });
  convert([...icnsFrames, join(desktopIcons, "icon.icns")]);
  console.log(`Wrote icon.icns (${ICNS_SIZES.join(", ")})`);

  renderSquare(512, join(publicDir, "app-icon.png"));
  renderSquare(512, join(publicDir, "app-icon-512.png"));
  console.log("Wrote public app icons");

  for (const p of tmp) rmSync(p, { force: true });

  const problems = verify();
  if (problems.length > 0) {
    console.error("\nGenerated icons failed verification:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nAll icons regenerated and verified.");
}

main();
