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

const ROOT = new URL("../..", import.meta.url).pathname;
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

// A cited test is a backticked snake_case token. Prose in backticks that is not
// a test — a constant, a field name — is filtered out by requiring it to look
// like a test name rather than by maintaining an allow-list, which would rot.
const isTestName = (token) =>
  /^[a-z][a-z0-9_]{6,}$/.test(token) &&
  // Real test names read as sentences; config constants are upper case and
  // would not reach here, while short identifiers are excluded by length.
  token.includes("_");

test("every test cited by the edge-case matrix exists", () => {
  const doc = readFileSync(DOC, "utf8");
  const cited = [...new Set(doc.match(/`([^`]+)`/g) ?? [])]
    .map((match) => match.slice(1, -1))
    // Sentence-style names belong to `it("...")` tests and are matched verbatim.
    .filter(
      (token) => isTestName(token) || /^[a-z]+ [a-z-]+ [a-z]/.test(token),
    );

  assert.ok(
    cited.length >= 40,
    `expected the matrix to cite at least 40 tests, found ${cited.length}`,
  );

  const missing = cited.filter((name) => !corpus.includes(name));
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
        /Verified — `[^`]+`/,
        `a Verified row must name its test: ${row.slice(0, 80)}`,
      );
    }
  }
});
