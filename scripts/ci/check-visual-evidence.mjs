#!/usr/bin/env node
/**
 * Visual evidence gate.
 *
 * A change that alters what a person sees is delivered with its screenshots in the pull
 * request description, where the reviewer starts. This check enforces that the description
 * carries them, and that the evidence is not buried where it will not be read.
 *
 * The procedure behind it is `docs/visual-verification/README.md`.
 *
 * Usage:
 *   node scripts/ci/check-visual-evidence.mjs <path>          # file
 *   printf '%s' "$BODY" | node scripts/ci/check-visual-evidence.mjs -
 *   node scripts/ci/check-visual-evidence.mjs body.md --base origin/main  # name the changed files
 *   PR_BODY="$BODY" node scripts/ci/check-visual-evidence.mjs --base "$BASE_SHA"
 *
 * Exit codes: 0 pass or not applicable, 1 violations, 2 usage or unreadable input.
 *
 * Rules:
 *   V1  the description embeds at least one image by markdown or HTML, pointing at a URL
 *       or a repository path. A check-list line alone is not evidence
 *   V2  no evidence image is hidden inside a `<details>` fold. A folded image is not seen
 *   V3  at least one image is unfolded, so `V1` cannot be satisfied only from a fold
 *   V4  when the diff against `--base` (or the staged index without it) touches a UI path
 *       and carries no unfolded image, fail and name the procedure. This is the trigger
 *       that makes the gate run without anyone remembering to run it
 *   V5  a local absolute path is rejected: evidence a reviewer cannot open is not evidence
 *
 * Scope: the authored body ends at the footer line, matching `check-pr-body.mjs`. Review
 * bots rewrite the region below it, and that text is not the author's claim.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const IMAGE =
  /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
const LOCAL_PATH = /^(?:\/|~\/|[A-Za-z]:\\|file:)/;

/**
 * Paths whose change alters a rendered surface. Deliberately broad: the cost of a false
 * positive is one screenshot, and the cost of a false negative is a change nobody looked at.
 */
const UI_MARKERS = [
  /^apps\/desktop\/src\/.+\.(tsx|css|json)$/,
  /^apps\/desktop\/src-tauri\/icons\//,
  /^apps\/preview\/src\//,
  /^apps\/docs\/src\//,
  /^marketing\//,
  /^branding\//,
  /^docs\/assets\/.+\.(png|gif|mp4|svg)$/,
  /^index\.html$/,
  /^README\.md$/,
  /^packages\/rust_(pill_shared|gtk_pill|macos_pill|windows_pill)\//,
  /^apps\/windows-installer\//,
];

/** A UI path that is not a rendered surface on its own. */
const NOT_A_SURFACE = [
  /^apps\/desktop\/src\/i18n\/locales\/.+\.json$/,
  /\.(test|spec|stories)\.[tj]sx?$/,
  /^apps\/desktop\/src\/.?test/i,
];

const FOOTER = /^<!--\s*footer\s*-->/i;

export const isUiPath = (path) =>
  UI_MARKERS.some((marker) => marker.test(path)) &&
  !NOT_A_SURFACE.some((exempt) => exempt.test(path));

/** Split the authored body from anything a bot appended below the footer. */
export const splitAuthored = (body) => {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => FOOTER.test(line.trim()));
  if (index === -1) return { authored: body, found: false };
  return { authored: lines.slice(0, index).join("\n"), found: true };
};

/** Blank out `<details>` blocks so their contents cannot satisfy a rule. */
export const withoutFolds = (body) =>
  body.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, "<details></details>");

/** Every image source in the given text, in order. */
export const images = (text) => {
  const found = [];
  for (const match of text.matchAll(IMAGE)) {
    found.push((match[1] ?? match[2] ?? "").trim());
  }
  return found;
};

/**
 * Check a description against the rules.
 *
 * @param {{ body: string, changedPaths?: string[] }} input
 * @returns {{ failures: { rule: string, message: string }[], noted: string[] }}
 */
export function checkVisualEvidence({ body, changedPaths = [] }) {
  const failures = [];
  const noted = [];

  const { authored, found } = splitAuthored(body ?? "");
  if (!found) {
    noted.push(
      "no footer line: the whole body counts as authored, including any bot text. Add one to scope the check.",
    );
  }

  const surfaced = changedPaths.filter(isUiPath);
  const all = images(authored);
  const open = images(withoutFolds(authored));

  for (const source of all) {
    if (LOCAL_PATH.test(source)) {
      failures.push({
        rule: "V5",
        message: `image "${source}" is a local path a reviewer cannot open. Upload it and use the returned URL, or commit it under docs/assets/`,
      });
    }
  }

  if (surfaced.length > 0 && all.length === 0) {
    failures.push({
      rule: "V4",
      message: `the diff under review touches ${surfaced.length} UI path(s) with no unfolded image in the description (${surfaced
        .slice(0, 3)
        .join(
          ", ",
        )}${surfaced.length > 3 ? ", …" : ""}). Capture the touched surfaces and embed the dark frames per docs/visual-verification/README.md`,
    });
    return { failures, noted };
  }

  if (changedPaths.length > 0 && surfaced.length === 0) {
    noted.push("the diff touches no UI path, so there is nothing to capture");
    return { failures, noted };
  }

  if (all.length === 0) {
    noted.push("the description carries no image");
  } else if (open.length === 0) {
    failures.push({
      rule: "V2",
      message: `all ${all.length} image(s) sit inside a <details> fold. Evidence is read above the fold`,
    });
    failures.push({
      rule: "V3",
      message: "no image is unfolded",
    });
  }

  return { failures, noted };
}

const run = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Files changed by the diff under review: the base range when given, else the index.
 *
 * The three-dot form is the pull request's own view, but it needs a merge base, and CI
 * checks out with `--depth=1`, where two shallow histories have none and git exits with
 * "no merge base". That is a property of the checkout, not of the change, so the two-dot
 * tree comparison is the fallback: it names the same files from the same two commits
 * without needing their common ancestor.
 */
export const changedPaths = (base) => {
  const names = (args) => run(args).split("\n").filter(Boolean);
  if (!base) {
    return names(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  }
  try {
    return names([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      `${base}...HEAD`,
    ]);
  } catch {
    return names(["diff", "--name-only", "--diff-filter=ACMR", base, "HEAD"]);
  }
};

const parseArgs = (argv) => {
  const args = { file: null, base: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      args.base = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    args.file = arg;
  }
  return args;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`${args.error}\n`);
    return 2;
  }
  if (!args.file && !process.env.PR_BODY) {
    process.stderr.write(
      "usage: check-visual-evidence.mjs <path> [--base <ref>] | PR_BODY=... <path|--base>\n",
    );
    return 2;
  }

  let body;
  try {
    body = args.file
      ? readFileSync(args.file === "-" ? 0 : args.file, "utf8")
      : process.env.PR_BODY;
  } catch (error) {
    process.stderr.write(`cannot read the body: ${error.message}\n`);
    return 2;
  }

  let paths = [];
  try {
    paths = changedPaths(args.base);
  } catch (error) {
    process.stderr.write(`cannot read the diff: ${error.message}\n`);
    return 2;
  }

  const { failures, noted } = checkVisualEvidence({
    body,
    changedPaths: paths,
  });

  for (const note of noted) process.stdout.write(`note: ${note}\n`);
  for (const failure of failures)
    process.stdout.write(`${failure.rule}: ${failure.message}\n`);

  if (failures.length > 0) {
    process.stdout.write(
      `\n${failures.length} violation(s). The procedure is docs/visual-verification/README.md\n`,
    );
    return 1;
  }
  process.stdout.write("ok: visual evidence present\n");
  return 0;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
