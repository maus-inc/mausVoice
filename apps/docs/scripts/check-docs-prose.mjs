#!/usr/bin/env node
/**
 * Guardrail ensuring published docs never ship em dashes, horizontal bars,
 * HTML dash entities, or non-range en dashes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const srcRoot = join(import.meta.dirname, "..", "src");
const PROHIBITED_DASH_RE =
  /\u2014|\u2015|(?<!\d)\u2013|\u2013(?!\d)|&[mn]dash;|&#(?:8211|8212|x2013|x2014);/i;
const CHECKED_EXTS = new Set([".md", ".mdx", ".astro", ".ts", ".tsx"]);

const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!CHECKED_EXTS.has(extname(fullPath))) continue;
    const rel = relative(srcRoot, fullPath).replaceAll("\\", "/");
    const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(PROHIBITED_DASH_RE);
      if (match) {
        failures.push(
          `${rel}:${i + 1}: prohibited dash ${JSON.stringify(match[0])} in published docs`,
        );
      }
    }
  }
}

walk(srcRoot);

if (failures.length > 0) {
  console.error(
    "docs prose check failed:\n" + failures.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}
console.log("docs prose check ok");
