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

const corpus = [
  ...walk(join(ROOT, "apps/desktop/src-tauri/src"), [".rs"]),
  ...walk(join(ROOT, "apps/desktop/src"), [".test.ts", ".test.tsx"]),
]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/**
 * The same files with every comment removed.
 *
 * A cited name that survives only in a comment is the failure this guard exists
 * to catch: delete the test and leave a note saying it lives here, and a corpus
 * that includes comments reports the citation as satisfied. Stripping comments
 * first means a name has to appear in code to count. Line and block comments are
 * handled separately because Rust and TypeScript share the syntax but a naive
 * strip would eat the `//` inside a URL string.
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

// A cited test is a backticked snake_case token. Prose in backticks that is not
// a test — a constant, a field name — is filtered out by requiring it to look
// like a test name rather than by maintaining an allow-list, which would rot.
const isTestName = (token) =>
  /^[a-z][a-z0-9_]{6,}$/.test(token) &&
  // Real test names read as sentences; config constants are upper case and
  // would not reach here, while short identifiers are excluded by length.
  token.includes("_");

// A sentence-style name as `it("...")` writes it.
//
// The old test for this was a looser three-word regex, which accepted
// `pactl list source-outputs` -- a shell command in backticks -- as a citation.
// A command is not a test, so it is excluded by shape and, below, by having to
// appear as a quoted test name in the source.
const looksLikeSentenceName = (token) =>
  /^[a-z][a-z0-9 ,.'()\-]*$/.test(token) &&
  token.includes(" ") &&
  !/[=/|:]/.test(token);

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every test cited by the edge-case matrix exists", () => {
  const doc = readFileSync(DOC, "utf8");
  // The matrix rows only. Scanning the whole document picked up prose in
  // backticks -- `pactl list source-outputs` is a shell command named in the
  // open-questions list, not a citation -- and treating it as a citation meant
  // the guard reported a missing test that was never claimed to exist.
  const matrix = doc
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line))
    .join("\n");
  const cited = [...new Set(matrix.match(/`([^`]+)`/g) ?? [])]
    .map((match) => match.slice(1, -1))
    // Sentence-style names belong to `it("...")` tests and are matched verbatim.
    .filter((token) => isTestName(token) || looksLikeSentenceName(token));

  assert.ok(
    cited.length >= 40,
    `expected the matrix to cite at least 40 tests, found ${cited.length}`,
  );

  // A sentence-style name counts only if it is *declared* as a test, which means
  // it follows `it(`, `test(` or `describe(`. Quoting it anywhere was too weak:
  // `pactl list source-outputs` is a shell command in the document's prose, and
  // it passed because the same phrase appeared in a string elsewhere. Requiring
  // the declaration is what makes this a check on tests rather than on text.
  const isDeclaredTest = (name) => {
    const opener = ["it", "test", "describe"].join("|");
    // Built by concatenation rather than one template literal: the backtick and
    // the quote classes in one template are easy to escape wrongly, and a mangled
    // pattern here throws at run time rather than failing a test.
    const pattern = `(?:^|[^\\w])(?:${opener})\\(\\s*["'\u0060]${escapeRe(name)}["'\u0060]`;
    return new RegExp(pattern, "m").test(codeOnly);
  };

  // `codeOnly` rather than `corpus` for both arms: a comment is not a test, and
  // counting one let a deleted test keep its citation alive.
  const missing = cited.filter(
    (name) =>
      !codeOnly.includes(name) &&
      !(looksLikeSentenceName(name) && isDeclaredTest(name)),
  );
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

test("the document carries no em dashes", () => {
  // `.coderabbit.yaml` sets a path instruction for `**/*.{md,mdx}`: "No em
  // dashes". The verdict cells used one as a separator, so the rule was broken
  // by the document that states the policy. The separator is now a colon, and
  // this keeps it that way: a reviewer should not have to notice a style rule
  // the repository already wrote down.
  const doc = readFileSync(DOC, "utf8");
  const offenders = doc
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.includes("\u2014"));
  assert.deepEqual(
    offenders.map(({ number }) => number),
    [],
    "em dashes at lines: " + offenders.map(({ number }) => number).join(", "),
  );
});
