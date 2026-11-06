import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConvertBinary } from "../../../scripts/imagemagick-resolution.mjs";

describe("ImageMagick executable resolution", () => {
  it("prioritizes an explicit absolute file and rejects invalid overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "magick-resolve-"));
    try {
      const file = join(dir, "convert");
      writeFileSync(file, "fixture");
      expect(resolveConvertBinary(`  ${file}  `, [])).toBe(file);
      expect(() => resolveConvertBinary("relative/convert", [])).toThrow(
        "must be an absolute path",
      );
      expect(() => resolveConvertBinary(dir, [])).toThrow(
        "does not point at a file",
      );
      expect(() => resolveConvertBinary(join(dir, "missing"), [])).toThrow(
        "does not point at a file",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches only the explicitly trusted directories, in order", () => {
    const root = mkdtempSync(join(tmpdir(), "magick-search-"));
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, "convert"), "fixture");
      writeFileSync(join(second, "magick"), "fixture");
      expect(resolveConvertBinary("", [first, second])).toBe(
        join(first, "convert"),
      );
      writeFileSync(join(first, "magick"), "fixture");
      expect(resolveConvertBinary("", [first, second])).toBe(
        join(first, "magick"),
      );
      expect(() => resolveConvertBinary("", [join(root, "none")])).toThrow(
        "not found in a trusted location",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
