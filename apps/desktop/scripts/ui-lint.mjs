#!/usr/bin/env node
/**
 * Guardrails so the UI language and production copy stay unified.
 * Run from lint-desktop / `pnpm --filter desktop lint`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = join(import.meta.dirname, "..", "src");
const localesRoot = join(root, "i18n", "locales");

const allowHex = new Set([
  "styles/palette.ts",
  "styles/tokens.css",
  "styles/shadows.ts",
  "components/onboarding/TutorialForm.tsx",
  "components/welcome/VectorField.tsx",
]);

/**
 * Non-UI files that legitimately mention em dashes in dash-scrubbing logic,
 * LLM anti-em-dash prompt instructions, or dev-only preview fixtures.
 * No UI component or locale catalog may be added here.
 */
const allowDashInStrings = new Set([
  "agents/agent-configs.ts",
  "preview/scenarios.ts",
  "utils/fast-style.utils.ts",
  "utils/humanize.utils.ts",
  "utils/tone.utils.ts",
]);

/**
 * Rejects any em dash (U+2014), horizontal bar (U+2015), HTML dash entity,
 * or non-range en dash (U+2013 not flanked by digits like "1-3" / "1–3").
 */
const PROHIBITED_DASH_RE =
  /\u2014|\u2015|(?<!\d)\u2013|\u2013(?!\d)|&[mn]dash;|&#(?:8211|8212|x2013|x2014);/i;

export function findProhibitedProductionDash(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const match = PROHIBITED_DASH_RE.exec(value);
  return match ? match[0] : null;
}

function isTestFile(rel) {
  return (
    rel.includes("__tests__/") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".spec.tsx")
  );
}

function isFormattedMessageDescription(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isJsxAttribute(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === "description"
  ) {
    const jsxAttrs = parent.parent;
    const tag = jsxAttrs?.parent;
    if (
      tag &&
      (ts.isJsxSelfClosingElement(tag) || ts.isJsxOpeningElement(tag)) &&
      ts.isIdentifier(tag.tagName) &&
      tag.tagName.text === "FormattedMessage"
    ) {
      return true;
    }
  }
  return false;
}

export function scanSourceDashes(rel, text) {
  const issues = [];
  if (allowDashInStrings.has(rel) || isTestFile(rel)) {
    return issues;
  }
  const ext = extname(rel);
  if (ext !== ".ts" && ext !== ".tsx") {
    return issues;
  }
  const scriptKind = ext === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (!isFormattedMessageDescription(node)) {
        const hit = findProhibitedProductionDash(node.text);
        if (hit) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          issues.push(
            `${rel}:${line + 1}: prohibited dash ${JSON.stringify(hit)} in string literal`,
          );
        }
      }
    } else if (ts.isJsxText(node)) {
      const raw = node.getText(sourceFile);
      const hit =
        findProhibitedProductionDash(node.text) ??
        findProhibitedProductionDash(raw);
      if (hit) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        issues.push(
          `${rel}:${line + 1}: prohibited dash ${JSON.stringify(hit)} in JSX text`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
}

export function scanLocaleCatalog(localeLabel, messages) {
  const issues = [];
  for (const [key, value] of Object.entries(messages)) {
    const hit = findProhibitedProductionDash(value);
    if (hit) {
      issues.push(
        `${localeLabel}:${key}: prohibited dash ${JSON.stringify(hit)} in locale message`,
      );
    }
  }
  return issues;
}

export function scanSourceText(rel, text) {
  const issues = [];
  if (/transition:\s*["']?all["']?/.test(text)) {
    issues.push(`${rel}: transition: all`);
  }
  if (!allowHex.has(rel)) {
    const hex = text.match(/#[0-9a-fA-F]{3,8}\b/g);
    if (hex) {
      const blues = hex.filter((h) =>
        /#1b8af8|#3198ff|#1a7cd4|#2787e6/i.test(h),
      );
      if (blues.length) {
        issues.push(`${rel}: leftover hue-blue ${blues.join(",")}`);
      }
    }
  }
  if (/borderRadius:\s*["']\d+px["']/.test(text)) {
    issues.push(`${rel}: pixel borderRadius literal`);
  }
  if (/\.format\(\s*["']MMM /.test(text)) {
    issues.push(`${rel}: dayjs display format string`);
  }
  issues.push(...scanSourceDashes(rel, text));
  return issues;
}

function runCli() {
  const failures = [];

  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "__tests__" || name === ".cache") continue;
        walk(p);
        continue;
      }
      if (![".ts", ".tsx", ".css"].includes(extname(p))) continue;
      const rel = relative(root, p).replaceAll("\\", "/");
      const text = readFileSync(p, "utf8");
      failures.push(...scanSourceText(rel, text));
    }
  }

  walk(root);

  for (const name of readdirSync(localesRoot).sort()) {
    if (!name.endsWith(".json")) continue;
    const p = join(localesRoot, name);
    const messages = JSON.parse(readFileSync(p, "utf8"));
    failures.push(...scanLocaleCatalog(`i18n/locales/${name}`, messages));
  }

  if (failures.length) {
    console.error(
      "ui-lint failed:\n" + failures.map((f) => `  - ${f}`).join("\n"),
    );
    process.exit(1);
  }
  console.log("ui-lint ok");
}

const isMain =
  typeof process.argv[1] === "string" &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  runCli();
}
