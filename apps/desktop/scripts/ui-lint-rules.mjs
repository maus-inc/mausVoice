import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const allowHex = new Set([
  "styles/palette.ts",
  "styles/tokens.css",
  "styles/shadows.ts",
  "components/onboarding/TutorialForm.tsx",
  "components/welcome/VectorField.tsx",
]);

/** Return UI convention violations for one source file. */
export function scanUiSource(rel, text) {
  const failures = [];
  if (/transition:\s*["']?all\b/.test(text)) {
    failures.push(`${rel}: transition: all`);
  }
  if (!allowHex.has(rel)) {
    const hex = text.match(/#[0-9a-fA-F]{3,8}\b/g);
    if (hex) {
      const blues = hex.filter((h) =>
        /#1b8af8|#3198ff|#1a7cd4|#2787e6/i.test(h),
      );
      if (blues.length)
        failures.push(`${rel}: leftover hue-blue ${blues.join(",")}`);
    }
  }
  if (/borderRadius:\s*["']\d+px["']/.test(text)) {
    failures.push(`${rel}: pixel borderRadius literal`);
  }
  if (/\.format\(\s*["']MMM /.test(text)) {
    failures.push(`${rel}: dayjs display format string`);
  }
  return failures;
}

/** Traverse source without following links out of the tree or through cycles. */
export function scanUiTree(root, dir = root) {
  const failures = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      failures.push(`${rel}: symbolic links are not supported in UI source`);
    } else if (entry.isDirectory()) {
      if (entry.name !== "__tests__") failures.push(...scanUiTree(root, path));
    } else if (
      entry.isFile() &&
      [".ts", ".tsx", ".css"].includes(extname(path))
    ) {
      failures.push(...scanUiSource(rel, readFileSync(path, "utf8")));
    }
  }
  return failures;
}
