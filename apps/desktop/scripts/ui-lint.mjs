#!/usr/bin/env node
/**
 * Guardrails so the UI language stays unified.
 * Run from lint-desktop / `pnpm --filter desktop lint`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "src");
const allowHex = new Set([
  "styles/palette.ts",
  "styles/tokens.css",
  "styles/shadows.ts",
  "components/onboarding/TutorialForm.tsx",
  "components/welcome/VectorField.tsx",
]);

const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      walk(p);
      continue;
    }
    if (![".ts", ".tsx", ".css"].includes(extname(p))) continue;
    const rel = relative(root, p).replaceAll("\\", "/");
    const text = readFileSync(p, "utf8");
    scan(rel, text);
  }
}

function scan(rel, text) {
  if (text.includes("transition: \"all") || text.includes("transition: 'all")) {
    failures.push(`${rel}: transition: all`);
  }
  if (!allowHex.has(rel) && !rel.startsWith("styles/")) {
    const hex = text.match(/#[0-9a-fA-F]{3,8}\b/g);
    if (hex) {
      const filtered = hex.filter((h) => !["#fff", "#FFF", "#000"].includes(h));
      // still flag leftover hue-blue
      const blues = hex.filter((h) => /#1b8af8|#3198ff|#1a7cd4|#2787e6/i.test(h));
      if (blues.length) failures.push(`${rel}: leftover hue-blue ${blues.join(",")}`);
    }
  }
  if (
    /borderRadius:\s*["']\d+px["']/.test(text) &&
    !["components/common/AppStepper.tsx", "components/onboarding/A11yPermsForm.tsx", "components/onboarding/MicPermsForm.tsx"].includes(rel)
  ) {
    failures.push(`${rel}: pixel borderRadius literal`);
  }
  if (/\.format\(\s*["']MMM /.test(text)) {
    failures.push(`${rel}: dayjs display format string`);
  }
}

walk(root);

if (failures.length) {
  console.error("ui-lint failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("ui-lint ok");
