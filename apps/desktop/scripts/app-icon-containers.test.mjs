import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseIcoFrames,
  parseIcnsFrames,
  checkIcoFrameSizes,
  checkIcnsFrameSizes,
  parseCornerAlpha,
} from "../../../scripts/app-icon-containers.mjs";

const ico = () => {
  const data = Buffer.alloc(23);
  data.writeUInt16LE(1, 2);
  data.writeUInt16LE(1, 4);
  data.writeUInt16LE(32, 12);
  data.writeUInt32LE(1, 14);
  data.writeUInt32LE(22, 18);
  return data;
};

const icns = () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12);
  png.writeUInt32BE(512, 16);
  png.writeUInt32BE(512, 20);
  const data = Buffer.alloc(16 + png.length);
  data.write("icns");
  data.writeUInt32BE(data.length, 4);
  data.write("ic09", 8);
  data.writeUInt32BE(8 + png.length, 12);
  png.copy(data, 16);
  return data;
};

describe("icon containers", () => {
  it("accepts real packaged icon directories", () => {
    for (const path of [
      "../src-tauri/icons/icon.ico",
      "../../windows-installer/src-tauri/icons/icon.ico",
    ]) {
      const data = readFileSync(fileURLToPath(new URL(path, import.meta.url)));
      expect(parseIcoFrames(data, path).length).toBeGreaterThan(0);
    }
    const data = readFileSync(
      fileURLToPath(new URL("../src-tauri/icons/icon.icns", import.meta.url)),
    );
    expect(parseIcnsFrames(data, "real.icns").length).toBeGreaterThan(0);
  });

  it("decodes ICO 256px dimensions and rejects truncated directories and payloads", () => {
    expect(parseIcoFrames(ico(), "icon.ico")).toEqual([
      { width: 256, height: 256, bpp: 32 },
    ]);
    expect(() => parseIcoFrames(ico().subarray(0, 10), "icon.ico")).toThrow(
      "truncated ICO directory",
    );
    const invalid = ico();
    invalid.writeUInt32LE(100, 18);
    expect(() => parseIcoFrames(invalid, "icon.ico")).toThrow(
      "invalid payload range",
    );
  });

  it("validates ICNS chunk boundaries and reports non-PNG frames", () => {
    expect(parseIcnsFrames(icns(), "icon.icns")).toEqual([
      { type: "ic09", width: 512, height: 512 },
    ]);
    const nonPng = icns();
    nonPng[16] = 0;
    expect(parseIcnsFrames(nonPng, "icon.icns")[0]).toEqual({
      type: "ic09",
      width: null,
      height: null,
    });
    const badLength = icns();
    badLength.writeUInt32BE(200, 12);
    expect(() => parseIcnsFrames(badLength, "icon.icns")).toThrow(
      "invalid length",
    );
    const trailing = Buffer.concat([icns(), Buffer.from([0])]);
    trailing.writeUInt32BE(trailing.length, 4);
    expect(() => parseIcnsFrames(trailing, "icon.icns")).toThrow(
      "trailing byte",
    );
  });
  it("reports missing or incorrectly encoded ICO frames", () => {
    const frames = [{ width: 16, height: 16, bpp: 24 }];
    expect(checkIcoFrameSizes("icon.ico", frames, [16, 32])).toEqual([
      "icon.ico: missing a 32x32 frame",
      "icon.ico: frame 16x16 is 24bpp, need 32bpp for alpha",
    ]);
    expect(
      checkIcoFrameSizes(
        "icon.ico",
        [{ width: 16, height: 16, bpp: 32 }],
        [16],
      ),
    ).toEqual([]);
  });

  it("reports missing ICNS chunks and mismatched dimensions", () => {
    const frames = [{ type: "ic09", width: 128, height: 128 }];
    expect(
      checkIcnsFrameSizes("icon.icns", frames, [
        { type: "ic09", size: 512 },
        { type: "ic10", size: 1024 },
      ]),
    ).toEqual([
      "icon.icns: 'ic09' frame is 128x128, expected 512x512",
      "icon.icns: missing the 1024x1024 'ic10' frame",
    ]);
    expect(
      checkIcnsFrameSizes("icon.icns", frames, [{ type: "ic09", size: 128 }]),
    ).toEqual([]);
  });
  it("rejects invalid ImageMagick alpha probes rather than treating them as transparent", () => {
    expect(parseCornerAlpha(" 0.02\n", "icon.png")).toBe(0.02);
    for (const result of ["", "NaN", "0.1garbage", "-0.1", "1.1", "Infinity"]) {
      expect(() => parseCornerAlpha(result, "icon.png")).toThrow(
        "invalid corner alpha",
      );
    }
  });
});
