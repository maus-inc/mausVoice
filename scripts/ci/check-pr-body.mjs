#!/usr/bin/env node
/**
 * PR body fold check.
 *
 * A pull request description stays readable only when the long records live behind a fold.
 * Review rounds, babysit polls, CI logs and research notes belong inside a `<details>` block,
 * never appended as a new heading each round. This check enforces the shape, not the content.
 *
 * Usage:
 *   node scripts/ci/check-pr-body.mjs <path>      # file
 *   printf '%s' "$BODY" | node scripts/ci/check-pr-body.mjs -
 *   pnpm run check:pr-body -- <path>              # same, through the package script
 *
 * Options:
 *   --max-open <n>   fail when the unfolded body exceeds n non-blank lines (default 150)
 *
 * Exit codes: 0 pass, 1 violations, 2 usage or unreadable input.
 *
 * Rules:
 *   R1  every `<details>` opens its content with a `<summary>`, so a reader knows what is inside
 *   R2  every `<details>` is closed
 *   R3  no unfolded heading names a review, babysit, poll, round, check, CI, log, triage or
 *       research record. Those sections are folded, so the heading becomes the `<summary>`
 *   R4  the unfolded part of the body stays within the line budget
 *   R5  the footer line appears exactly once, outside any fold
 *   R6  every visible level-2 heading is one of the four the template keeps unfolded
 */

import { readFileSync } from "node:fs";
import process from "node:process";

const FOLDABLE_HEADING =
  /(review|babysit|poll|round|checks?\b|\bci\b|logs?\b|triage|research|fix log|re verification)/i;

// The template keeps four sections unfolded. Anything else visible is a record that belongs in a fold.
const VISIBLE_HEADING =
  /^##\s+(Summary|Verification gate|Checklist|Footer)\s*$/;

function parseArgs(argv) {
  const args = { file: null, maxOpen: 150 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max-open") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        return { error: "--max-open needs a positive integer" };
      }
      args.maxOpen = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      return { error: `unknown option ${arg}` };
    }
    args.file = arg;
  }
  return args;
}

function readBody(file) {
  if (file && file !== "-") {
    return readFileSync(file, "utf8");
  }
  return readFileSync(0, "utf8");
}

function stripNoise(raw, state) {
  let line = raw;
  const fence =
    line.trimStart().startsWith("```") || line.trimStart().startsWith("~~~");
  if (state.inFence) {
    if (fence) {
      state.inFence = false;
    }
    return "";
  }
  if (fence) {
    state.inFence = true;
    return "";
  }
  if (state.inComment) {
    const end = line.indexOf("-->");
    if (end === -1) {
      return "";
    }
    line = line.slice(end + 3);
    state.inComment = false;
  }
  line = line.replace(/<!--[\s\S]*?-->/g, "");
  const commentStart = line.indexOf("<!--");
  if (commentStart !== -1) {
    line = line.slice(0, commentStart);
    state.inComment = true;
  }
  // Inline code is prose, not markup. A body that explains a <details> tag must not open one.
  return line.replace(/`[^`]*`/g, "");
}

function check(body, maxOpen) {
  const lines = body.split("\n");
  const violations = [];
  const state = { inComment: false, inFence: false };
  let depth = 0;
  let awaitingSummary = false;
  let openLines = 0;
  let footerCount = 0;
  let footerInsideFold = false;

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const scan = stripNoise(raw, state).trim();
    if (scan === "") {
      return;
    }

    const opens = (scan.match(/<details\b/gi) ?? []).length;
    const closes = (scan.match(/<\/details>/gi) ?? []).length;
    const wasOpen = depth > 0;

    if (!wasOpen) {
      openLines += 1;
      if (/^## /.test(scan) && !VISIBLE_HEADING.test(scan)) {
        violations.push(
          `R6 line ${lineNo}: visible heading "${scan}" is not one of Summary, Verification gate, Checklist or Footer. Fold it and use the title as the <summary>.`,
        );
      }
      if (/^#{1,6} /.test(scan) && FOLDABLE_HEADING.test(scan)) {
        violations.push(
          `R3 line ${lineNo}: unfolded heading "${scan}" records a review, log or research round. Fold the section and use the title as the <summary>.`,
        );
      }
      if (scan.startsWith("MausAgent | Filed by ")) {
        footerCount += 1;
      }
    } else if (scan.startsWith("MausAgent | Filed by ")) {
      footerInsideFold = true;
    }

    const hasSummary = /<summary>[\s\S]*<\/summary>/i.test(scan);

    if (opens > 0) {
      // A one-line <details><summary>...</summary> is valid HTML, turns up in bot
      // boilerplate, and needs no follow-up line. A bare <details> does.
      awaitingSummary = !hasSummary;
    } else if (awaitingSummary && depth > 0) {
      awaitingSummary = false;
      if (!hasSummary) {
        violations.push(
          `R1 line ${lineNo}: a <details> block starts with "${scan}" instead of a <summary>.`,
        );
      }
    }

    depth = Math.max(0, depth + opens - closes);
    if (depth === 0) {
      awaitingSummary = false;
    }
  });

  if (depth > 0) {
    violations.push(`R2: ${depth} <details> block(s) are never closed.`);
  }
  if (openLines > maxOpen) {
    violations.push(
      `R4: the unfolded body is ${openLines} lines, over the budget of ${maxOpen}. Fold the long part, do not delete it.`,
    );
  }
  if (footerCount === 0 && !footerInsideFold) {
    violations.push(
      "R5: the footer line 'MausAgent | Filed by ...' is missing.",
    );
  }
  if (footerCount > 1) {
    violations.push(
      `R5: the footer line appears ${footerCount} times. Keep one, at the end.`,
    );
  }
  if (footerInsideFold) {
    violations.push(
      "R5: the footer line sits inside a fold. The footer stays visible.",
    );
  }

  return { violations, openLines };
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(`check-pr-body: ${args.error}`);
  process.exit(2);
}

let body;
try {
  body = readBody(args.file);
} catch (error) {
  console.error(
    `check-pr-body: cannot read ${args.file ?? "stdin"}: ${error.message}`,
  );
  process.exit(2);
}

if (body.trim() === "") {
  console.error("check-pr-body: the body is empty. A description is required.");
  process.exit(1);
}

const { violations, openLines } = check(body, args.maxOpen);

if (violations.length > 0) {
  console.error(
    `check-pr-body: ${violations.length} violation(s) in the body.`,
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error(
    "Every review round, babysit poll, CI log and research note belongs inside a <details> block. See .github/pull_request_template.md.",
  );
  process.exit(1);
}

console.log(
  `check-pr-body: ok, ${openLines} unfolded lines, all long records folded.`,
);
