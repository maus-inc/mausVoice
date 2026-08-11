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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directories trusted to provide the ImageMagick binary, in priority order.
 *
 * Resolving the executable ourselves — rather than letting the OS search
 * `$PATH` — means a writable or attacker-controlled directory earlier in
 * `$PATH` cannot substitute its own `convert`. Callers can still point at a
 * specific binary with `IMAGEMAGICK_CONVERT`, which is validated below.
 */
const TRUSTED_BIN_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
];

/** Absolute path to the ImageMagick binary, resolved once at startup. */
let convertBin = null;

/**
 * Locate ImageMagick without trusting `$PATH` ordering.
 *
 * Order: an explicit `IMAGEMAGICK_CONVERT` override, then the trusted
 * directories above. Both ImageMagick 7 (`magick`) and 6 (`convert`) are
 * accepted.
 */
function resolveConvertBinary() {
  const override = process.env.IMAGEMAGICK_CONVERT?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(
        `IMAGEMAGICK_CONVERT must be an absolute path, got: ${override}`,
      );
    }
    if (!existsSync(override) || !statSync(override).isFile()) {
      throw new Error(
        `IMAGEMAGICK_CONVERT does not point at a file: ${override}`,
      );
    }
    return override;
  }

  // Keep only trusted directories that actually appear in PATH-like locations;
  // the list itself is fixed, so nothing user-writable can be injected here.
  for (const dir of TRUSTED_BIN_DIRS) {
    for (const name of ["magick", "convert"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  throw new Error(
    "ImageMagick was not found in a trusted location.\n" +
      `Searched: ${TRUSTED_BIN_DIRS.join(delimiter)}\n` +
      "Install it, or set IMAGEMAGICK_CONVERT to an absolute path:\n" +
      "  macOS:  brew install imagemagick\n" +
      "  Ubuntu: sudo apt-get install imagemagick",
  );
}

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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Executes ImageMagick with the specified arguments.
 * @param {string[]} args - Arguments to pass to ImageMagick.
 * @return {Buffer} The command's standard output.
 */
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
 * Parses an ICO file and returns metadata for each contained frame.
 * @param {string} path - Path to the ICO file.
 * @return {Array<{width: number, height: number, bpp: number}>} The frame dimensions and bit depths.
 * @throws {Error} If the file is not a valid ICO file.
 */
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
 * Creates an ICNS file from PNG frames at the configured icon sizes.
 * @param {Map<number, string>} framePathBySize - Maps each frame size to its PNG file path.
 * @param {string} outPath - Path where the ICNS file is written.
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

/** Width/height from a PNG's IHDR, or nulls when the payload is not a PNG. */
function readPngSize(payload) {
  if (payload.length < 24 || !payload.subarray(0, 8).equals(PNG_MAGIC)) {
    return { width: null, height: null };
  }
  return { width: payload.readUInt32BE(16), height: payload.readUInt32BE(20) };
}

/**
 * Parses an ICNS container and extracts the type and dimensions of each PNG frame.
 * @param {string} path - The path to the ICNS file.
 * @return {{type: string, width: number, height: number}[]} The ICNS frame descriptors.
 * @throws {Error} If the file is not a valid ICNS container or contains invalid chunk lengths.
 */
function readIcnsFrames(path) {
  const data = readFileSync(path);
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "icns") {
    throw new Error(
      `${path} is not an ICNS container (a renamed PNG will not do)`,
    );
  }
  const declared = data.readUInt32BE(4);
  if (declared !== data.length) {
    throw new Error(
      `${path}: header declares ${declared} bytes but the file is ${data.length}`,
    );
  }

  const frames = [];
  for (let offset = 8; offset + 8 <= data.length; ) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length) {
      throw new Error(`${path}: chunk '${type}' declares an invalid length`);
    }
    frames.push({
      type,
      ...readPngSize(data.subarray(offset + 8, offset + length)),
    });
    offset += length;
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
    convertBin,
    [imageSpec, "-alpha", "on", "-format", "%[fx:p{0,0}.a]", "info:"],
    { encoding: "utf8" },
  );
  return Number.parseFloat(out.trim());
}

/** True when a corner pixel is opaque enough to look like a black square. */
function isCornerOpaque(alpha) {
  return Number.isFinite(alpha) && alpha > CORNER_ALPHA_TOLERANCE;
}

/**
 * Validates that an ICO file contains all required square frame sizes with 32-bit color depth.
 * @param {string} ico - The ICO file path used in validation messages.
 * @param {Array<{width: number, height: number, bpp: number}>} frames - The ICO frames to validate.
 * @return {string[]} Validation problems found.
 */
function checkIcoFrameSizes(ico, frames) {
  const problems = [];

  for (const size of ICO_SIZES) {
    if (
      !frames.some((frame) => frame.width === size && frame.height === size)
    ) {
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
  return problems;
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

/** Validate one directory's icon.ico. */
function checkIco(dir) {
  const ico = join(dir, "icon.ico");
  if (!existsSync(ico)) {
    return [`missing ${ico}`];
  }
  const frames = readIcoFrames(ico);
  return [
    ...checkIcoFrameSizes(ico, frames),
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
    frames = readIcnsFrames(icns);
  } catch (err) {
    return [err.message];
  }

  const problems = [];
  for (const { type, size } of ICNS_FRAMES) {
    const frame = frames.find((candidate) => candidate.type === type);
    if (!frame) {
      problems.push(`${icns}: missing the ${size}x${size} '${type}' frame`);
      continue;
    }
    if (frame.width !== size || frame.height !== size) {
      problems.push(
        `${icns}: '${type}' frame is ${frame.width}x${frame.height}, expected ${size}x${size}`,
      );
    }
  }
  return problems;
}

/** Validate a representative sample of the generated PNGs. */
function checkPng(name) {
  const path = join(desktopIcons, name);
  if (!existsSync(path)) {
    return [`missing ${path}`];
  }
  return isCornerOpaque(cornerAlpha(path)) ? [`${path}: opaque corner`] : [];
}

/**
 * Collects validation errors for ICO, ICNS, and representative PNG assets.
 * @returns {string[]} Validation error messages, or an empty array when all assets are valid.
 */
function verify() {
  return [
    ...[desktopIcons, installerIcons].flatMap(checkIco),
    ...checkIcns(desktopIcons),
    ...["icon.png", "32x32.png", "128x128.png"].flatMap(checkPng),
  ];
}

/**
 * Generates application icon assets or verifies existing assets when run with `--check`.
 *
 * @throws {Error} If the branding master is missing or ImageMagick cannot be used.
 */
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
      "App icons OK: alpha preserved, every required ICO frame present, " +
        "and icon.icns is a real multi-resolution container.",
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
  try {
    const icoFrames = ICO_SIZES.map((size) => {
      const p = join(desktopIcons, `.tmp-ico-${size}.png`);
      renderSquare(size, p);
      tmp.push(p);
      return p;
    });
    convert([...icoFrames, join(desktopIcons, "icon.ico")]);
    convert([...icoFrames, join(installerIcons, "icon.ico")]);
    console.log(`Wrote icon.ico (${ICO_SIZES.join(", ")})`);

    const icnsFrames = new Map(
      ICNS_SIZES.map((size) => {
        const p = join(desktopIcons, `.tmp-icns-${size}.png`);
        renderSquare(size, p);
        tmp.push(p);
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
  } finally {
    for (const p of tmp) rmSync(p, { force: true });
  }

  const problems = verify();
  if (problems.length > 0) {
    console.error("\nGenerated icons failed verification:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nAll icons regenerated and verified.");
}

main();
