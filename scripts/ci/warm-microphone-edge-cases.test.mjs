// Keeps docs/qa/warm-microphone-edge-cases.md honest.
//
// The table cites the test that holds each row. A table that names a test which
// does not exist is worse than no table: it reads as coverage and delivers none.
// This walks every cited name and fails if one is not found in the source, so a
// renamed or removed test breaks the build rather than the document's promise.
//
//   node --test scripts/ci/warm-microphone-edge-cases.test.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `URL.pathname`: a path containing a space comes back
// percent-encoded from `pathname`, so a checkout at "/home/me/my repo" produced
// "/home/me/my%20repo/docs/..." and every readFileSync below failed with ENOENT
// before a single row was checked.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC = join(ROOT, "docs/qa/warm-microphone-edge-cases.md");
const MEASUREMENTS = new URL(
  "../../docs/qa/warm-microphone-measurements.md",
  import.meta.url,
);

const walk = (dir, extensions) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Generated and dependency trees carry no tests of ours.
      if (entry === "node_modules" || entry === "target" || entry === "dist") {
        continue;
      }
      out.push(...walk(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
};

/**
 * Every test file, with every comment removed.
 *
 * There is no comment-preserving variant, and that is the point. A cited name
 * that survives only in a comment is the failure this guard exists to catch:
 * delete the test and leave a note saying it lives here, and a corpus that
 * includes comments reports the citation as satisfied. Stripping comments first
 * means a name has to appear in code to count. Line and block comments are
 * handled separately because Rust and TypeScript share the syntax but a naive
 * strip would eat the `//` inside a URL string.
 *
 * This used to be two constants, `corpus` and `codeOnly`. The comment-inclusive
 * one stopped being read when both arms of the citation check moved to the
 * stripped text, and it sat there for a release looking like coverage.
 */
const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const codeOnly = [
  ...walk(join(ROOT, "apps/desktop/src-tauri/src"), [".rs"]),
  ...walk(join(ROOT, "apps/desktop/src"), [".test.ts", ".test.tsx"]),
]
  .map((file) => stripComments(readFileSync(file, "utf8")))
  .join("\n");

/**
 * The citation rules, in one place.
 *
 * Two guards used to live here and both were wrong in the same direction — they
 * classified a token by its *shape* and dropped the ones that looked like prose.
 * That is how a short name such as `gone` could be written into a `Verified:` cell
 * and assert nothing, and how `pactl list source-outputs` could be reported as a
 * missing test. Shape cannot decide this: a sentence-style test name contains
 * capitals and spaces, and prose can look exactly like a short test name.
 *
 * So nothing is classified or dropped now. Citations come from the verdict cell
 * only, and every one of them has to be a declaration in the source.
 */

// A name declared as a Rust test: `fn <name>(`.
const isRustTestDeclaration = (name, source) =>
  new RegExp(`fn\\s+${escapeRe(name)}\\s*\\(`).test(source);

// A name declared as a JS/TS test: a quoted name after `it(`, `test(` or
// `describe(`.
//
// Built by concatenation rather than one template literal: the backtick and the
// quote classes in one template are easy to escape wrongly, and a mangled pattern
// here throws at run time rather than failing a test.
const isScriptTestDeclaration = (name, source) => {
  const opener = ["it", "test", "describe"].join("|");
  const pattern = `(?:^|[^\\w])(?:${opener})\\(\\s*["'\u0060]${escapeRe(name)}["'\u0060]`;
  return new RegExp(pattern, "m").test(source);
};

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every test cited by the edge-case matrix exists", () => {
  const doc = readFileSync(DOC, "utf8");
  // The verdict cell only, not the whole row.
  //
  // The condition column names fields and values -- `linger_ms`, `NaN`,
  // `expected_duration` -- and those are backticked too, so scanning the row
  // treated identifiers as test citations and demanded a test named after each
  // field. The claim being checked is "this row is verified by this test", and
  // that claim lives entirely in the last cell.
  //
  // Scanning the whole document was the original mistake in the other
  // direction: `pactl list source-outputs` is a shell command named in the
  // open-questions list, and treating it as a citation meant the guard reported
  // a missing test that was never claimed to exist.
  const matrix = doc
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => line.slice(line.lastIndexOf("|", line.length - 2) + 1))
    .join("\n");
  // No token is discarded here. Anything that is not explicitly prose is
  // validated below, so a mistyped or deleted citation fails instead of being
  // filtered out of the check.
  // Every backticked token in a verdict cell is a citation, with no prose filter.
  //
  // The filter this replaces existed because the scan covered whole rows and then
  // the whole document, where most backticks are field names and shell commands.
  // It hid a real case: a short name such as `gone` matched the "bare word"
  // branch of `isProseNotCitation` and was dropped before validation, so a
  // `Verified: gone` row asserted nothing. A verdict cell claims what proves the
  // row, so anything named there has to be a test.
  const cited = [...new Set(matrix.match(/`([^`]+)`/g) ?? [])].map((match) =>
    match.slice(1, -1),
  );

  assert.ok(
    cited.length >= 40,
    `expected the matrix to cite at least 40 tests, found ${cited.length}`,
  );

  // A sentence-style name counts only if it is *declared* as a test, which means
  // it follows `it(`, `test(` or `describe(`. Quoting it anywhere was too weak:
  // `pactl list source-outputs` is a shell command in the document's prose, and
  // it passed because the same phrase appeared in a string elsewhere. Requiring
  // the declaration is what makes this a check on tests rather than on text.
  const isDeclaredTest = (name) =>
    isRustTestDeclaration(name, codeOnly) ||
    isScriptTestDeclaration(name, codeOnly);

  // Every cited name has to be a *declaration*, in both naming styles.
  //
  // The old first arm was `codeOnly.includes(name)`, which accepted the name
  // appearing anywhere in the source -- a comment, a string, an unrelated
  // identifier -- so deleting the test while leaving its name in any of those
  // kept the citation alive. That is the opposite of what this guard is for.
  // Short snake_case names made it concrete: a name like `gone` is filtered out
  // of the citation list as prose, and a name that survived the filter could
  // still be satisfied by a doc comment.
  //
  // A comment is not a test, so both arms read `codeOnly`.
  const missing = cited.filter((name) => !isDeclaredTest(name));
  assert.deepEqual(
    missing,
    [],
    `the matrix cites tests that do not exist: ${missing.join(", ")}`,
  );
});

test("the matrix has at least fifty numbered rows", () => {
  const doc = readFileSync(DOC, "utf8");
  const rows = [...doc.matchAll(/^\| (\d+) \|/gm)].map((match) =>
    Number(match[1]),
  );
  assert.ok(rows.length >= 50, `expected 50+ rows, found ${rows.length}`);

  // Numbering is the reader's index, so a duplicate or a gap is a real defect
  // in the document rather than a style preference.
  const expected = Array.from({ length: rows.length }, (_, index) => index + 1);
  assert.deepEqual(rows, expected, "row numbers are not 1..n in order");
});

test("every row states how it is checked", () => {
  const doc = readFileSync(DOC, "utf8");
  const rows = doc.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  // Three verdicts only. "Verified" without a named test is the failure this
  // guards: it reads as coverage while proving nothing.
  for (const row of rows) {
    assert.match(
      row,
      /\| (Verified|Inspected|Cannot verify here)\b/,
      `row has no verdict: ${row.slice(0, 80)}`,
    );
    if (row.includes("| Verified")) {
      // Two naming styles are in use: `snake_case` for Rust tests and a quoted
      // sentence for the TypeScript `it("...")` tests. Both are real names, so
      // both are accepted; what is rejected is a verdict with no name at all,
      // such as "same test" or "see above", which cannot be checked.
      assert.match(
        row,
        /Verified: `[^`]+`/,
        `a Verified row must name its test: ${row.slice(0, 80)}`,
      );
    }
  }
});

test("the QA documents carry no em dashes", () => {
  // `.coderabbit.yaml` sets a path instruction for `**/*.{md,mdx}`: "No em
  // dashes". The verdict cells used one as a separator, so the rule was broken by
  // the document that states the policy. The separator is now a colon, and this
  // keeps it that way: a reviewer should not have to notice a style rule the
  // repository already wrote down.
  //
  // Both QA documents, not just the matrix. This test used to read `DOC` alone,
  // and the sibling measurements document had an em dash the whole time — a guard
  // that covers one of two files reads like a guard over both.
  const offenders = [];
  for (const file of [DOC, MEASUREMENTS]) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (line.includes("\u2014")) {
          offenders.push(`${file.split("/").pop()}:${index + 1}`);
        }
      });
  }
  assert.deepEqual(offenders, [], "em dashes at " + offenders.join(", "));
});
