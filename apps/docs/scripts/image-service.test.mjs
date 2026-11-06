import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import sharp from "sharp";
import astroSharpService from "astro/assets/services/sharp";

test("Astro's image service can resize the docs logo with its installed Sharp backend", async () => {
  const source = await readFile(new URL("../src/assets/logo.png", import.meta.url));
  const original = await sharp(source).metadata();
  assert.ok(original.width > 32 && original.height > 32);
  const result = await astroSharpService.transform(
    source,
    { src: "logo.png", width: 32, format: "webp" },
    { service: { config: {} } },
  );
  const output = await sharp(result.data).metadata();
  assert.equal(result.format, "webp");
  assert.equal(output.format, "webp");
  assert.equal(output.width, 32);
  assert.ok(output.height > 0);
});
