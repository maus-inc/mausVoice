import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  TARGET_HEIGHT,
  TARGET_WIDTH,
  chooseBackground,
  decodeBmp,
  decodeImage,
  decodePng,
  drawContainFit,
  encodeBmp24,
  verifyOutput,
} from "../../../scripts/generate-windows-installer-sidebar.mjs";

/**
 * Unit coverage for the NSIS sidebar generator. The build only fails at the
 * Windows bundle step, so every decoder rejection path, the scaling math and
 * the BMP encoder are pinned here instead - they run on every platform as
 * part of `pnpm --filter desktop run test:unit`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const generatorPath = join(repoRoot, "scripts", "generate-windows-installer-sidebar.mjs");

/** One opaque image: solid `color`, alpha 255, at the given size. */
function solidImage(width, height, color) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba.set([...color, 255], i * 4);
  }
  return { width, height, rgba };
}

/** PNG chunk with a zero CRC: the decoder intentionally ignores CRCs. */
function pngChunk(type, data) {
  const buf = Buffer.alloc(12 + data.length);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4, "ascii");
  data.copy(buf, 8);
  return buf;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Paeth predictor, mirroring the PNG spec (the decoder has its own copy). */
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
 * Apply PNG scanline filters encoder-side so the decoder's defiltering can
 * be round-tripped: `filters` cycles per row, predictor values are computed
 * from the unfiltered samples exactly as the spec defines them.
 */
function encodeRows(samples, width, height, channels, filters) {
  const rowBytes = width * channels;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y % filters.length];
    const cur = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? samples.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    const row = Buffer.alloc(1 + rowBytes);
    row[0] = filter;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= channels ? cur[x - channels] : 0;
      const up = prev !== null ? prev[x] : 0;
      const upLeft = prev !== null && x >= channels ? prev[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      row[1 + x] = (cur[x] - predictor) & 0xff;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

/**
 * Assemble a synthetic PNG. `samples` are defiltered per-pixel samples for
 * the colour type; options cover the rejection paths (odd bit depth,
 * interlacing, colour-key tRNS, truncated IDAT, bogus filter byte).
 */
function buildPng(width, height, colorType, samples, options = {}) {
  const channels = PNG_CHANNELS[colorType];
  const filters = options.filters ?? [0];
  const raw =
    options.rawRows ??
    encodeRows(Buffer.from(samples), width, height, channels, filters);
  const parts = [PNG_SIGNATURE];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = colorType;
  ihdr[12] = options.interlace ?? 0;
  parts.push(pngChunk("IHDR", ihdr));
  if (options.palette) parts.push(pngChunk("PLTE", Buffer.from(options.palette)));
  if (options.trns) parts.push(pngChunk("tRNS", Buffer.from(options.trns)));
  let idat = deflateSync(raw);
  if (options.truncateIdat) idat = idat.subarray(0, Math.max(1, idat.length >> 2));
  parts.push(pngChunk("IDAT", idat));
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Pixel accessor over a decoded RGBA buffer. */
function px(image, x, y) {
  return Array.from(image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));
}

describe("decodePng", () => {
  it("decodes grayscale (colour type 0)", () => {
    const png = buildPng(3, 1, 0, [10, 200, 55]);
    const image = decodePng(png);
    expect(image.width).toBe(3);
    expect(image.format).toBe("PNG");
    expect(px(image, 0, 0)).toEqual([10, 10, 10, 255]);
    expect(px(image, 2, 0)).toEqual([55, 55, 55, 255]);
  });

  it("decodes truecolour RGB (colour type 2)", () => {
    const png = buildPng(2, 1, 2, [1, 2, 3, 250, 251, 252]);
    const image = decodePng(png);
    expect(px(image, 1, 0)).toEqual([250, 251, 252, 255]);
  });

  it("decodes grayscale+alpha (colour type 4)", () => {
    const png = buildPng(2, 1, 4, [99, 128, 200, 0]);
    const image = decodePng(png);
    expect(px(image, 0, 0)).toEqual([99, 99, 99, 128]);
    expect(px(image, 1, 0)).toEqual([200, 200, 200, 0]);
  });

  it("decodes RGBA (colour type 6)", () => {
    const png = buildPng(2, 1, 6, [1, 2, 3, 4, 250, 251, 252, 0]);
    const image = decodePng(png);
    expect(px(image, 0, 0)).toEqual([1, 2, 3, 4]);
    expect(px(image, 1, 0)).toEqual([250, 251, 252, 0]);
  });

  it("decodes palette indices with per-index tRNS alpha (colour type 3)", () => {
    const png = buildPng(2, 1, 3, [0, 1], {
      palette: [10, 20, 30, 200, 150, 100],
      trns: [255, 128],
    });
    const image = decodePng(png);
    expect(px(image, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(px(image, 1, 0)).toEqual([200, 150, 100, 128]);
  });

  it("round-trips all five scanline filters", () => {
    // 5 rows, one per filter, with content that makes every predictor matter.
    const samples = [];
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        samples.push((x * 37 + y * 91) & 0xff, (x * 17 + y * 53) & 0xff, (x * 7 + y * 29) & 0xff);
      }
    }
    const png = buildPng(4, 5, 2, samples, { filters: [0, 1, 2, 3, 4] });
    const image = decodePng(png);
    expect(px(image, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(image, 3, 4)).toEqual([
      (3 * 37 + 4 * 91) & 0xff,
      (3 * 17 + 4 * 53) & 0xff,
      (3 * 7 + 4 * 29) & 0xff,
      255,
    ]);
    // Full-buffer equality: defiltering must reproduce the samples exactly.
    const expected = new Uint8Array(4 * 5 * 4);
    for (let i = 0; i < 4 * 5; i += 1) {
      expected.set([samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], 255], i * 4);
    }
    expect(Buffer.from(image.rgba).equals(Buffer.from(expected))).toBe(true);
  });

  it("rejects 16-bit depth", () => {
    const png = buildPng(1, 1, 0, [0], { bitDepth: 16 });
    expect(() => decodePng(png)).toThrow(/8-bit/);
  });

  it("rejects interlaced PNG", () => {
    const png = buildPng(1, 1, 0, [0], { interlace: 1 });
    expect(() => decodePng(png)).toThrow(/interlaced/);
  });

  it("rejects colour-key tRNS on grayscale and RGB", () => {
    const rgb = buildPng(1, 1, 2, [0, 0, 0], { trns: [0, 0, 0, 0, 0, 0] });
    const gray = buildPng(1, 1, 0, [0], { trns: [0, 0] });
    expect(() => decodePng(rgb)).toThrow(/tRNS/);
    expect(() => decodePng(gray)).toThrow(/tRNS/);
  });

  it("rejects an unknown scanline filter", () => {
    const png = buildPng(1, 1, 0, [7], { rawRows: Buffer.from([7, 200]) });
    expect(() => decodePng(png)).toThrow(/unknown filter 7/);
  });

  it("rejects truncated image data", () => {
    const png = buildPng(4, 4, 6, new Array(4 * 4 * 4).fill(9), { truncateIdat: true });
    expect(() => decodePng(png)).toThrow();
  });
});

/** Minimal BI_RGB BMP builder for the decoder-side tests. */
function buildBmp({ width, height, bpp, compression = 0, topDown = false, fill }) {
  const bytesPerPixel = bpp / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const declaredHeight = topDown ? -height : height;
  const buf = Buffer.alloc(54 + stride * height);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(declaredHeight, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(bpp, 28);
  buf.writeUInt32LE(compression, 30);
  // Bottom-up unless topDown: fill every row with the BGR(A) triple.
  for (let y = 0; y < height; y += 1) {
    const row = topDown ? y : height - 1 - y;
    const base = 54 + row * stride;
    for (let x = 0; x < width; x += 1) {
      // `fill` is [r, g, b]; BMP scanlines store B, G, R order.
      buf[base + x * bytesPerPixel] = fill[2];
      buf[base + x * bytesPerPixel + 1] = fill[1];
      buf[base + x * bytesPerPixel + 2] = fill[0];
    }
  }
  return buf;
}

describe("decodeBmp", () => {
  it("round-trips a 24-bit canvas produced by encodeBmp24", () => {
    const canvas = drawContainFit(solidImage(TARGET_WIDTH, TARGET_HEIGHT, [12, 34, 56]), [0, 0, 0]);
    const decoded = decodeBmp(encodeBmp24(canvas));
    expect(decoded.width).toBe(TARGET_WIDTH);
    expect(decoded.height).toBe(TARGET_HEIGHT);
    expect(decoded.format).toBe("BMP (24-bit)");
    expect(px(decoded, 0, 0)).toEqual([12, 34, 56, 255]);
    expect(px(decoded, TARGET_WIDTH - 1, TARGET_HEIGHT - 1)).toEqual([12, 34, 56, 255]);
  });

  it("decodes 32-bit top-down bitmaps", () => {
    const decoded = decodeBmp(buildBmp({ width: 3, height: 2, bpp: 32, topDown: true, fill: [9, 8, 7] }));
    expect(decoded.format).toBe("BMP (32-bit)");
    expect(px(decoded, 1, 0)).toEqual([9, 8, 7, 255]);
  });

  it("rejects compressed and sub-24-bit bitmaps", () => {
    const rle = buildBmp({ width: 2, height: 2, bpp: 24, compression: 1, fill: [0, 0, 0] });
    const sixteen = buildBmp({ width: 2, height: 2, bpp: 16, fill: [0, 0, 0] });
    expect(() => decodeBmp(rle)).toThrow(/compressed/);
    expect(() => decodeBmp(sixteen)).toThrow(/24\/32-bit/);
  });
});

describe("decodeImage", () => {
  it("sniffs PNG and BMP containers and rejects anything else", () => {
    expect(decodeImage(buildPng(1, 1, 0, [5])).format).toBe("PNG");
    expect(decodeImage(buildBmp({ width: 1, height: 1, bpp: 24, fill: [1, 2, 3] })).format).toContain("BMP");
    expect(() => decodeImage(Buffer.from("definitely not an image"))).toThrow(/unsupported image format/);
  });
});

describe("chooseBackground", () => {
  it("falls back to wizard white when no edge sample is opaque", () => {
    const transparent = solidImage(4, 4, [100, 100, 100]);
    transparent.rgba.fill(0, 0, transparent.rgba.length); // alpha 0 everywhere
    expect(chooseBackground(transparent)).toEqual([255, 255, 255]);
  });

  it("averages opaque edge samples for a seamless letterbox", () => {
    expect(chooseBackground(solidImage(4, 4, [180, 30, 60]))).toEqual([180, 30, 60]);
  });
});

describe("drawContainFit + encodeBmp24", () => {
  it("copies exact-fit art without resampling", () => {
    const canvas = drawContainFit(solidImage(TARGET_WIDTH, TARGET_HEIGHT, [200, 100, 50]), [1, 2, 3]);
    expect(Array.from(canvas.subarray(0, 4))).toEqual([200, 100, 50, 255]);
    expect(Array.from(canvas.subarray(canvas.length - 4))).toEqual([200, 100, 50, 255]);
  });

  it("contain-fits landscape art and letterboxes with the background", () => {
    const canvas = drawContainFit(solidImage(320, 200, [180, 30, 60]), [10, 20, 30]);
    const image = { width: TARGET_WIDTH, height: TARGET_HEIGHT, rgba: canvas };
    // 320x200 scales to 164x103 (offsetY 105): rows 5 and 309 at x=82 are
    // letterbox, the centre is art. Avoid the blend rows at the fit edges.
    expect(px(image, 82, 5)).toEqual([10, 20, 30, 255]);
    expect(px(image, 82, 309)).toEqual([10, 20, 30, 255]);
    expect(px(image, 82, 157)).toEqual([180, 30, 60, 255]);
    // 164-wide 24-bit rows are already 4-byte aligned: no padding bytes.
    expect(encodeBmp24(canvas).length).toBe(54 + 492 * TARGET_HEIGHT);
  });
});

describe("verifyOutput", () => {
  it("accepts a generated bitmap and rejects a tampered one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mausvoice-sidebar-test-"));
    const canvas = drawContainFit(solidImage(TARGET_WIDTH, TARGET_HEIGHT, [5, 5, 5]), [0, 0, 0]);
    const bmp = encodeBmp24(canvas);
    const good = join(dir, "good.bmp");
    writeFileSync(good, bmp);
    expect(() => verifyOutput(good)).not.toThrow();
    bmp.writeInt32LE(100, 18); // width no longer 164
    const bad = join(dir, "bad.bmp");
    writeFileSync(bad, bmp);
    expect(() => verifyOutput(bad)).toThrow(/width/);
  });
});

describe("generator CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "mausvoice-sidebar-cli-"));

  it("regenerates the bitmap from environment overrides", () => {
    const source = join(dir, "art.png");
    const output = join(dir, "out.bmp");
    writeFileSync(source, buildPng(8, 8, 6, new Array(8 * 8 * 4).fill(120)));
    execFileSync(process.execPath, [generatorPath], {
      env: {
        ...process.env,
        MAUSVOICE_SIDEBAR_SOURCE: source,
        MAUSVOICE_SIDEBAR_OUTPUT: output,
      },
    });
    const bmp = readFileSync(output);
    expect(bmp.readInt32LE(18)).toBe(TARGET_WIDTH);
    expect(bmp.readInt32LE(22)).toBe(TARGET_HEIGHT);
    expect(bmp.readUInt16LE(28)).toBe(24);
  });

  it("fails with the art contract when the source is missing", () => {
    const output = join(dir, "missing.bmp");
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [generatorPath], {
        env: {
          ...process.env,
          MAUSVOICE_SIDEBAR_SOURCE: join(dir, "does-not-exist.png"),
          MAUSVOICE_SIDEBAR_OUTPUT: output,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      status = err.status;
      stderr = err.stderr?.toString() ?? "";
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain("branding/mausvoice-sidebar-installerimg.png");
  });

  it("is a no-op off Windows under --windows-only", (ctx) => {
    if (process.platform === "win32") ctx.skip(); // covered by the strict runs
    const output = join(dir, "skipped.bmp");
    execFileSync(process.execPath, [generatorPath, "--windows-only"], {
      env: { ...process.env, MAUSVOICE_SIDEBAR_OUTPUT: output },
    });
    expect(existsSync(output)).toBe(false);
  });
});
