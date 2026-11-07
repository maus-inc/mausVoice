import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packages = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages");
const withoutDevelopment = (value) => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutDevelopment);
  return Object.fromEntries(Object.entries(value)
    .filter(([condition]) => condition !== "development")
    .map(([condition, target]) => [condition, withoutDevelopment(target)]));
};

for (const entry of readdirSync(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packages, entry.name, "package.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (manifest.private || !JSON.stringify(manifest.exports)?.includes('"development"')) continue;
  test(`${manifest.name} keeps workspace source conditions out of dist-only releases`, () => {
    assert.deepEqual(manifest.publishConfig?.exports, withoutDevelopment(manifest.exports));
    const packed = { ...manifest, ...manifest.publishConfig };
    assert.equal(JSON.stringify(packed.exports).includes("./src/"), false);
    assert.ok(packed.main.startsWith("dist/"));
    assert.ok(packed.types.startsWith("dist/"));
    assert.ok(packed.files.includes("dist"));
  });
}
