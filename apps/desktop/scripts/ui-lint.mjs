#!/usr/bin/env node
/**
 * Guardrails so the UI language stays unified.
 * Run from lint-desktop / `pnpm --filter desktop lint`.
 */
import { join } from "node:path";
import { scanUiTree } from "./ui-lint-rules.mjs";

const failures = scanUiTree(join(import.meta.dirname, "..", "src"));
if (failures.length) {
  console.error(
    "ui-lint failed:\n" + failures.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}
console.log("ui-lint ok");
