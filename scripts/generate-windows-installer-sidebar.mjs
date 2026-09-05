#!/usr/bin/env node
/**
 * Convert the committed installer sidebar art into the NSIS bitmap.
 *
 * Why this script exists
 * ---------------------
 * The Windows setup (`mausVoice_*-setup.exe`, NSIS) shows a wizard whose
 * Welcome and Finish pages carry a tall image on the left. With no
 * `bundle.windows.nsis.sidebarImage` configured, Tauri falls back to the
 * stock NSIS panel - the default blue gradient this script replaces.
 *
 * NSIS modern-UI bitmaps must be plain 24-bit `.bmp` files (164x314 is the
 * documented sidebar size), while design tooling exports PNG. This script
 * owns that conversion so nobody has to hand-produce a BMP:
 *
 *   branding/mausvoice-sidebar-installerimg.png (repo; committed art, PNG/BMP)
 *        |
 *        |  composite onto an edge-sampled background, contain-fit,
 *        |  bilinear resample
 *        v
 *   apps/desktop/src-tauri/icons/nsis-sidebar.bmp   (generated, 164x314, 24bpp)
 *
 * The generated bitmap is gitignored and always rebuilt from the committed
 * art, so the two can never drift. It is produced by the uncached Tauri
 * wrapper (`scripts/run-tauri-with-sidecars.mjs`, so every `tauri build`
 * has a fresh copy regardless of Turbo cache hits on the `build` task)
 * and again explicitly in CI before the Windows bundle step.
 *
 * Usage:
 *   node scripts/generate-windows-installer-sidebar.mjs [--windows-only]
 *
 * `--windows-only` makes the script a no-op (exit 0) on non-Windows hosts;
 * the desktop `build` script uses it so mac/Linux builds - which never
 * bundle NSIS - are not gated on Windows installer art.
 *
 * Overrides (for testing; paths resolve against the repository root):
 *   MAUSVOICE_SIDEBAR_SOURCE  source art location
 *   MAUSVOICE_SIDEBAR_OUTPUT  generated bitmap location
 *
 * No third-party dependencies: PNG scanlines are inflated and defiltered
 * with `node:zlib` directly and the BMP container is assembled byte by byte,
 * mirroring `scripts/generate-app-icons.mjs`.
 *
 * The decoding, scaling and encoding stages are exported for the unit suite
 * at apps/desktop/scripts/generate-windows-installer-sidebar.test.mjs
 * (run by `pnpm --filter desktop run test:unit`); `main()` only runs when
 * the file is executed directly.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** NSIS welcome/finish sidebar size at standard 96 DPI (see Tauri NSIS docs). */
export const TARGET_WIDTH = 164;
export const TARGET_HEIGHT = 314;

/** Committed art, kept with the other branding assets. */
const SOURCE = process.env.MAUSVOICE_SIDEBAR_SOURCE
  ? resolve(repoRoot, process.env.MAUSVOICE_SIDEBAR_SOURCE)
  : join(repoRoot, "branding", "mausvoice-sidebar-installerimg.png");

/** Generated bitmap referenced by `bundle.windows.nsis.sidebarImage`. */
const OUTPUT = process.env.MAUSVOICE_SIDEBAR_OUTPUT
  ? resolve(repoRoot, process.env.MAUSVOICE_SIDEBAR_OUTPUT)
  : join(repoRoot, "apps", "desktop", "src-tauri", "icons", "nsis-sidebar.bmp");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Samples per pixel for each supported PNG colour type. */
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const MISSING_SOURCE_HINT = `Commit the custom art as
    branding/mausvoice-sidebar-installerimg.png
PNG (8-bit, non-interlaced) or BMP (24/32-bit uncompressed). Full-bleed
${TARGET_WIDTH}x${TARGET_HEIGHT} art renders edge to edge; other aspect
ratios are contain-fit and letterboxed. The Windows build regenerates
${"apps/desktop/src-tauri/icons/nsis-sidebar.bmp"} from it.`;

/** Paeth predictor, as specified by the PNG spec (integer arithmetic). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Walk a PNG's chunk list and collect the fields this decoder consumes.
 *
 * CRCs are not re-verified: inflateSync fails loudly on corrupted image
 * data, which is the only payload consumed here.
 */
function parsePngChunks(buf) {
  const png = {
    width: 0,
    height: 0,
    bitDepth: 0,
    colorType: -1,
    interlace: -1,
    palette: null,
    transparency: null,
    idat: [],
  };

  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > buf.length) {
      throw new Error(`PNG chunk '${type}' is truncated`);
    }
    const data = buf.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      png.width = data.readUInt32BE(0);
      png.height = data.readUInt32BE(4);
      png.bitDepth = data[8];
      png.colorType = data[9];
      png.interlace = data[12];
    } else if (type === "PLTE") {
      png.palette = data;
    } else if (type === "tRNS") {
      png.transparency = data;
    } else if (type === "IDAT") {
      png.idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;
  }
  return png;
}

/**
 * Reject the PNG variants this decoder does not handle, each with a message
 * saying how to re-export the art. One flat list keeps the supported
 * profile explicit.
 */
function validatePngHeader(png) {
  if (png.width <= 0 || png.height <= 0) {
    throw new Error("PNG is missing its IHDR chunk");
  }
  if (png.bitDepth !== 8) {
    throw new Error(
      `PNG bit depth ${png.bitDepth} is not supported (re-export as 8-bit)`,
    );
  }
  if (!(png.colorType in PNG_CHANNELS)) {
    throw new Error(`PNG colour type ${png.colorType} is not supported`);
  }
  if (png.interlace !== 0) {
    throw new Error(
      "interlaced PNG is not supported (re-export non-interlaced)",
    );
  }
  if (png.idat.length === 0) {
    throw new Error("PNG has no image data (IDAT)");
  }
  if (png.colorType === 3 && png.palette === null) {
    throw new Error("palette PNG is missing its PLTE chunk");
  }
  // Palette tRNS is handled during expansion; on every other colour type it
  // is either a colour key (grayscale/RGB), which this decoder does not
  // resolve, or malformed (alpha types 4/6 must not carry tRNS at all).
  // Either way, ignoring it would render the art fully opaque - reject it.
  if (png.transparency !== null && png.colorType !== 3) {
    throw new Error(
      "tRNS transparency is only supported on palette PNGs; re-export " +
        "grayscale/RGB art as RGBA (or without tRNS)",
    );
  }
}

/** Undo one PNG scanline filter byte for the given prediction neighbours. */
function unfilterByte(filter, rawByte, left, up, upLeft, row) {
  switch (filter) {
    case 0:
      return rawByte;
    case 1:
      return rawByte + left;
    case 2:
      return rawByte + up;
    case 3:
      return rawByte + ((left + up) >> 1);
    case 4:
      return rawByte + paeth(left, up, upLeft);
    default:
      throw new Error(`PNG scanline ${row} uses unknown filter ${filter}`);
  }
}

/** Defilter one scanline in place within the shared sample buffer. */
function defilterRow(inflated, y, samples, rowBytes, channels) {
  const base = y * (rowBytes + 1);
  const filter = inflated[base];
  const rowStart = y * rowBytes;
  const prevStart = rowStart - rowBytes;
  for (let x = 0; x < rowBytes; x += 1) {
    const left = x >= channels ? samples[rowStart + x - channels] : 0;
    const up = y > 0 ? samples[prevStart + x] : 0;
    const upLeft =
      x >= channels && y > 0 ? samples[prevStart + x - channels] : 0;
    const rawByte = inflated[base + 1 + x];
    samples[rowStart + x] =
      unfilterByte(filter, rawByte, left, up, upLeft, y) & 0xff;
  }
}

/**
 * Undo the per-scanline filters in place, one byte at a time. `left`, `up`
 * and `upLeft` are the neighbours the PNG spec defines; the up-neighbour
 * row is already final when it is read.
 */
function defilterScanlines(inflated, height, rowBytes, channels) {
  const samples = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y += 1) {
    defilterRow(inflated, y, samples, rowBytes, channels);
  }
  return samples;
}

/** Grayscale (colour type 0). */
function expandGraySample(samples, i, o, rgba) {
  const gray = samples[i];
  rgba[o] = gray;
  rgba[o + 1] = gray;
  rgba[o + 2] = gray;
  rgba[o + 3] = 255;
}

/** Truecolour RGB (colour type 2). */
function expandRgbSample(samples, i, o, rgba) {
  rgba[o] = samples[i * 3];
  rgba[o + 1] = samples[i * 3 + 1];
  rgba[o + 2] = samples[i * 3 + 2];
  rgba[o + 3] = 255;
}

/** Palette index (colour type 3), with per-index tRNS alpha. */
function expandPaletteSample(samples, i, o, rgba, palette, transparency) {
  const index = samples[i];
  if (index * 3 + 2 >= palette.length) {
    throw new Error(`palette index ${index} is out of range`);
  }
  rgba[o] = palette[index * 3];
  rgba[o + 1] = palette[index * 3 + 1];
  rgba[o + 2] = palette[index * 3 + 2];
  rgba[o + 3] =
    transparency !== null && index < transparency.length
      ? transparency[index]
      : 255;
}

/** Grayscale + alpha (colour type 4). */
function expandGrayAlphaSample(samples, i, o, rgba) {
  const gray = samples[i * 2];
  rgba[o] = gray;
  rgba[o + 1] = gray;
  rgba[o + 2] = gray;
  rgba[o + 3] = samples[i * 2 + 1];
}

/** Truecolour RGBA (colour type 6). */
function expandRgbaSample(samples, i, o, rgba) {
  rgba[o] = samples[i * 4];
  rgba[o + 1] = samples[i * 4 + 1];
  rgba[o + 2] = samples[i * 4 + 2];
  rgba[o + 3] = samples[i * 4 + 3];
}

/** Expand one defiltered sample buffer into RGBA for its colour type. */
function expandToRgba(
  samples,
  width,
  height,
  colorType,
  palette,
  transparency,
) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (colorType === 0) {
      expandGraySample(samples, i, o, rgba);
    } else if (colorType === 2) {
      expandRgbSample(samples, i, o, rgba);
    } else if (colorType === 3) {
      expandPaletteSample(samples, i, o, rgba, palette, transparency);
    } else if (colorType === 4) {
      expandGrayAlphaSample(samples, i, o, rgba);
    } else {
      expandRgbaSample(samples, i, o, rgba);
    }
  }
  return rgba;
}

/**
 * Decode a non-interlaced 8-bit PNG into raw RGBA.
 *
 * Supported colour types: grayscale (0), RGB (2), palette (3, with tRNS
 * alpha), gray+alpha (4) and RGBA (6). 16-bit depth, interlacing and tRNS
 * on any non-palette type are rejected - a clear error beats a silently
 * wrong banner (colour-key transparency would decode as fully opaque).
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("not a PNG (signature mismatch)");
  }

  const png = parsePngChunks(buf);
  validatePngHeader(png);

  const channels = PNG_CHANNELS[png.colorType];
  const rowBytes = png.width * channels;
  const inflated = inflateSync(Buffer.concat(png.idat));
  const expected = png.height * (rowBytes + 1);
  if (inflated.length < expected) {
    throw new Error(
      `PNG image data is truncated: ${inflated.length} bytes, expected ` +
        `${expected}`,
    );
  }

  const samples = defilterScanlines(inflated, png.height, rowBytes, channels);
  const rgba = expandToRgba(
    samples,
    png.width,
    png.height,
    png.colorType,
    png.palette,
    png.transparency,
  );
  return { width: png.width, height: png.height, rgba, format: "PNG" };
}

/**
 * Decode an uncompressed 24/32-bit BMP (BI_RGB) into opaque RGBA. Anything
 * else (RLE, JPEG/PNG embedded in a BMP container) is rejected outright.
 */
export function decodeBmp(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) {
    throw new Error("not a BMP (signature mismatch)");
  }
  if (buf.readUInt32LE(14) < 40) {
    throw new Error("BMP uses a pre-Windows-3 DIB header; not supported");
  }
  const width = buf.readInt32LE(18);
  let height = buf.readInt32LE(22);
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0) {
    throw new Error("BMP declares a zero-sized image");
  }
  if (buf.readUInt16LE(26) !== 1) {
    throw new Error("BMP plane count is not 1");
  }
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) {
    throw new Error(`only 24/32-bit BMPs are supported (got ${bpp}-bit)`);
  }
  if (buf.readUInt32LE(30) !== 0) {
    throw new Error("compressed BMPs are not supported (re-export as BI_RGB)");
  }
  const pixelOffset = buf.readUInt32LE(10);
  const bytesPerPixel = bpp / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  if (pixelOffset + stride * height > buf.length) {
    throw new Error("BMP pixel data is truncated");
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = topDown ? y : height - 1 - y;
    const rowStart = pixelOffset + sourceRow * stride;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + x * bytesPerPixel;
      const o = (y * width + x) * 4;
      rgba[o] = buf[p + 2];
      rgba[o + 1] = buf[p + 1];
      rgba[o + 2] = buf[p];
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba, format: `BMP (${bpp}-bit)` };
}

/** Sniff the container and decode to RGBA. */
export function decodeImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return decodePng(buf);
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return decodeBmp(buf);
  }
  throw new Error(
    "unsupported image format - commit a PNG (8-bit, non-interlaced) or a " +
      "24/32-bit uncompressed BMP as branding/mausvoice-sidebar-installerimg.png",
  );
}

/**
 * Letterbox background, averaged from the art's fully opaque corner and edge
 * samples. Full-bleed art therefore gets a seamless bar colour; art that is
 * transparent at every sample (a bare logo) falls back to the wizard's white.
 */
export function chooseBackground(image) {
  const { width, height, rgba } = image;
  const midX = Math.floor(width / 2);
  const midY = Math.floor(height / 2);
  const points = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
    [midX, 0],
    [midX, height - 1],
    [0, midY],
    [width - 1, midY],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const [x, y] of points) {
    const o = (y * width + x) * 4;
    if (rgba[o + 3] >= 230) {
      r += rgba[o];
      g += rgba[o + 1];
      b += rgba[o + 2];
      n += 1;
    }
  }
  if (n === 0) {
    return [255, 255, 255];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Composite the art over the background colour in place (no halos). */
function compositeOverBackground(image, background) {
  const { rgba } = image;
  for (let o = 0; o < rgba.length; o += 4) {
    const alpha = rgba[o + 3] / 255;
    rgba[o] = Math.round(rgba[o] * alpha + background[0] * (1 - alpha));
    rgba[o + 1] = Math.round(rgba[o + 1] * alpha + background[1] * (1 - alpha));
    rgba[o + 2] = Math.round(rgba[o + 2] * alpha + background[2] * (1 - alpha));
    rgba[o + 3] = 255;
  }
}

/** Bilinear sample of the opaque source at fractional coordinates. */
function sampleBilinear(image, x, y, out, outOffset) {
  const { width, height, rgba } = image;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));

  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  for (let c = 0; c < 3; c += 1) {
    const top = rgba[i00 + c] + (rgba[i10 + c] - rgba[i00 + c]) * fx;
    const bottom = rgba[i01 + c] + (rgba[i11 + c] - rgba[i01 + c]) * fx;
    out[outOffset + c] = Math.round(top + (bottom - top) * fy);
  }
  out[outOffset + 3] = 255;
}

/**
 * Contain-fit the art onto the target canvas, centred, with the letterbox
 * background everywhere else. An exact-size source short-circuits to a copy.
 */
export function drawContainFit(image, background) {
  const canvas = new Uint8Array(TARGET_WIDTH * TARGET_HEIGHT * 4);
  const scale = Math.min(
    TARGET_WIDTH / image.width,
    TARGET_HEIGHT / image.height,
  );
  const fitWidth = Math.max(1, Math.round(image.width * scale));
  const fitHeight = Math.max(1, Math.round(image.height * scale));
  const offsetX = Math.floor((TARGET_WIDTH - fitWidth) / 2);
  const offsetY = Math.floor((TARGET_HEIGHT - fitHeight) / 2);
  const exactFit =
    image.width === TARGET_WIDTH &&
    image.height === TARGET_HEIGHT &&
    fitWidth === TARGET_WIDTH &&
    fitHeight === TARGET_HEIGHT;

  for (let y = 0; y < TARGET_HEIGHT; y += 1) {
    for (let x = 0; x < TARGET_WIDTH; x += 1) {
      const o = (y * TARGET_WIDTH + x) * 4;
      const insideX = x >= offsetX && x < offsetX + fitWidth;
      const insideY = y >= offsetY && y < offsetY + fitHeight;
      if (!insideX || !insideY) {
        canvas[o] = background[0];
        canvas[o + 1] = background[1];
        canvas[o + 2] = background[2];
        canvas[o + 3] = 255;
        continue;
      }
      if (exactFit) {
        const s = (y * TARGET_WIDTH + x) * 4;
        canvas[o] = image.rgba[s];
        canvas[o + 1] = image.rgba[s + 1];
        canvas[o + 2] = image.rgba[s + 2];
        canvas[o + 3] = 255;
        continue;
      }
      const sx = ((x - offsetX + 0.5) / fitWidth) * image.width - 0.5;
      const sy = ((y - offsetY + 0.5) / fitHeight) * image.height - 0.5;
      sampleBilinear(image, sx, sy, canvas, o);
    }
  }
  return canvas;
}

/** Assemble a bottom-up 24-bit BI_RGB BMP, the flavour NSIS expects. */
export function encodeBmp24(rgba) {
  const rowSize = Math.ceil((TARGET_WIDTH * 3) / 4) * 4;
  const imageSize = rowSize * TARGET_HEIGHT;
  const buf = Buffer.alloc(54 + imageSize);

  // BITMAPFILEHEADER
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(0, 6); // reserved
  buf.writeUInt32LE(54, 10); // pixel data offset

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(TARGET_WIDTH, 18);
  buf.writeInt32LE(TARGET_HEIGHT, 22); // positive: rows stored bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bits per pixel
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(imageSize, 34);

  for (let y = 0; y < TARGET_HEIGHT; y += 1) {
    const sourceY = TARGET_HEIGHT - 1 - y;
    let p = 54 + y * rowSize;
    for (let x = 0; x < TARGET_WIDTH; x += 1) {
      const o = (sourceY * TARGET_WIDTH + x) * 4;
      buf[p] = rgba[o + 2]; // blue first: BMP scanlines are BGR
      buf[p + 1] = rgba[o + 1];
      buf[p + 2] = rgba[o];
      p += 3;
    }
  }
  return buf;
}

/** Re-read the generated file and assert it is what NSIS needs. */
export function verifyOutput(path) {
  const buf = readFileSync(path);
  const problems = [];
  if (buf.length < 54 || buf.toString("ascii", 0, 2) !== "BM") {
    problems.push("output is not a BMP");
  } else {
    if (buf.readInt32LE(18) !== TARGET_WIDTH) {
      problems.push(
        `width is ${buf.readInt32LE(18)}, expected ${TARGET_WIDTH}`,
      );
    }
    if (buf.readInt32LE(22) !== TARGET_HEIGHT) {
      problems.push(
        `height is ${buf.readInt32LE(22)}, expected ${TARGET_HEIGHT}`,
      );
    }
    if (buf.readUInt16LE(28) !== 24) {
      problems.push(`depth is ${buf.readUInt16LE(28)}bpp, expected 24bpp`);
    }
    if (buf.readUInt32LE(30) !== 0) {
      problems.push("bitmap is not uncompressed BI_RGB");
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `generated bitmap failed verification: ${problems.join("; ")}`,
    );
  }
}

function main() {
  // The desktop `build` script passes --windows-only: platforms that never
  // bundle NSIS must not be gated on Windows installer art.
  if (process.argv.includes("--windows-only") && process.platform !== "win32") {
    console.log(
      `Skipping NSIS sidebar generation (--windows-only, platform ${process.platform}).`,
    );
    return;
  }

  if (!existsSync(SOURCE)) {
    throw new Error(
      `Installer sidebar art not found: ${SOURCE}\n${MISSING_SOURCE_HINT}`,
    );
  }

  const image = decodeImage(readFileSync(SOURCE));
  console.log(
    `Sidebar art: ${SOURCE} (${image.format}, ${image.width}x${image.height})`,
  );

  const targetAspect = TARGET_WIDTH / TARGET_HEIGHT;
  const sourceAspect = image.width / image.height;
  if (Math.abs(sourceAspect - targetAspect) / targetAspect > 0.05) {
    console.log(
      `NOTE: art aspect ${sourceAspect.toFixed(3)} differs from the ` +
        `${TARGET_WIDTH}x${TARGET_HEIGHT} panel (${targetAspect.toFixed(3)}); ` +
        "it will be contain-fit and letterboxed. Full-bleed " +
        `${TARGET_WIDTH}x${TARGET_HEIGHT} art renders edge to edge.`,
    );
  }

  const background = chooseBackground(image);
  compositeOverBackground(image, background);
  const canvas = drawContainFit(image, background);
  const bmp = encodeBmp24(canvas);

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, bmp);
  verifyOutput(OUTPUT);

  const hex = background.map((v) => v.toString(16).padStart(2, "0")).join("");
  console.log(
    `Wrote ${OUTPUT} (${TARGET_WIDTH}x${TARGET_HEIGHT}, 24-bit BMP, ` +
      `${bmp.length} bytes; letterbox #${hex})`,
  );
}

// Only self-execute when invoked as a program (node scripts/…, the tauri
// wrapper, CI). Under `import` - the unit suite - stay side-effect free.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
