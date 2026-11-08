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
 *   R4  the unfolded part of the authored body stays within the line budget
 *   R5  the footer line appears exactly once, outside any fold
 *   R6  every visible level-2 heading is one of the four the template keeps unfolded. Tool
 *       wrappers, a level-2 heading written entirely in bold, are tolerated because review
 *       bots rewrite bodies with them and the author does not control that
 *   R7  all four of those sections are present, so the gate and the checklist cannot be dropped
 *   R8  no unfolded bullet records a numbered round, a babysit poll or a check run, which is
 *       the section-as-a-bullet version of R3. Checklist items are exempt
 *
 * Scope:
 *   The rules judge the authored body, and the authored body ends at the footer line. Review
 *   bots append and rewrite their own sections below that footer, without notice, on their own
 *   schedule and in their own markup, and the author does not control that text. Everything
 *   below the first unfolded footer line is therefore exempt from every rule except the
 *   duplicate-footer count in R5. The footer marks the boundary in both directions: records
 *   above it must fold, and bot material below it never fails the check.
 */

import { readFileSync } from "node:fs";
import process from "node:process";

const FOLDABLE_HEADING =
  /\b(review|babysit|poll|round|check|ci|log|triage|research)(es|s)?\b|\bfix log\b|\bre verification\b/i;

// The template keeps four sections unfolded. Anything else visible is a record that belongs in a fold.
const VISIBLE_HEADING =
  /^##\s+(Summary|Verification gate|Checklist|Footer)\s*$/;
// "## **User description**" is what a review bot wraps a body in. It is not a section.
const TOOL_WRAPPER = /^##\s+\*\*[^*]+\*\*\s*$/;
const REQUIRED_SECTIONS = [
  "Summary",
  "Verification gate",
  "Checklist",
  "Footer",
];
const ROUND_BULLET =
  /^[-*]\s+(?!\[[ xX]\]).*\b(round\s*\d+|babysit|poll\b|ci run|check run)/i;

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

// Job logs are public and permanent. Quote enough of the offending line to find it, not the line.
function quote(line, limit = 100) {
  return line.length > limit ? `${line.slice(0, limit)}...` : line;
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
  let botTerritory = false;
  const seenSections = new Set();

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const scan = stripNoise(raw, state).trim();
    if (scan === "") {
      return;
    }

    if (botTerritory) {
      // Below the footer the review bots write, and the author cannot control that text.
      // The only authored mistake still detectable down here is a second footer.
      if (scan.startsWith("MausAgent | Filed by ")) {
        footerCount += 1;
      }
      return;
    }

    const opens = (scan.match(/<details\b/gi) ?? []).length;
    const closes = (scan.match(/<\/details>/gi) ?? []).length;
    const wasOpen = depth > 0;

    if (!wasOpen) {
      openLines += 1;
      const section = /^##\s+(.+?)\s*$/.exec(scan);
      if (section && VISIBLE_HEADING.test(scan)) {
        seenSections.add(section[1]);
      }
      if (
        /^## /.test(scan) &&
        !VISIBLE_HEADING.test(scan) &&
        !TOOL_WRAPPER.test(scan)
      ) {
        violations.push(
          `R6 line ${lineNo}: visible heading "${quote(scan, 60)}" is not one of Summary, Verification gate, Checklist or Footer. Fold it and use the title as the <summary>.`,
        );
      }
      if (/^#{1,6} /.test(scan) && FOLDABLE_HEADING.test(scan)) {
        violations.push(
          `R3 line ${lineNo}: unfolded heading "${quote(scan, 60)}" records a review, log or research round. Fold the section and use the title as the <summary>.`,
        );
      }
      if (scan.startsWith("MausAgent | Filed by ")) {
        footerCount += 1;
        // The authored body ends here. Whatever the bots appended below is out of scope.
        botTerritory = true;
      }
      if (ROUND_BULLET.test(scan)) {
        violations.push(
          `R8 line ${lineNo}: unfolded bullet "${quote(scan, 60)}" records a round, a poll or a check run. Put it in the round log table.`,
        );
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
          `R1 line ${lineNo}: a <details> block starts with "${quote(scan)}" instead of a <summary>.`,
        );
      }
    }

    depth = Math.max(0, depth + opens - closes);
    if (depth === 0) {
      awaitingSummary = false;
    }
  });

  // The footer line is the Footer section, whether or not a "## Footer" heading precedes it.
  if (footerCount > 0) {
    seenSections.add("Footer");
  }
  const missing = REQUIRED_SECTIONS.filter((name) => !seenSections.has(name));
  if (missing.length > 0) {
    violations.push(
      `R7: the visible sections ${missing.map((name) => `"## ${name}"`).join(", ")} are missing. The template keeps all four unfolded.`,
    );
  }
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
      `R5: the footer line appears ${footerCount} times. Keep one, at the end of the authored body; the check stops at the first.`,
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
