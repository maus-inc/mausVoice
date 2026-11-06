// Config-structure guard for gitleaks.toml.
//
// NOTE: This is NOT a secret scanner. It does not (and cannot) detect secrets.
// It only asserts that gitleaks.toml is wired so that REAL Gitleaks, when run
// (see .github/workflows/secret-scan.yml), will actually detect a Base64-only
// Tauri/Minisign updater private-key preamble rather than exempting it.
//
// It guards the structure of the config: the preamble must be a detection rule
// (not an allowlist exemption), must not carry a `keywords` pre-filter that
// would short-circuit Base64-only keys, `useDefault` must not be wrongly
// nested under `[allowlist]`, and `[extend] useDefault = true` must explicitly
// include the built-in rules when a custom configuration is supplied. Run with:
//   node scripts/ci/check-gitleaks-config.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { testBoundedRegex } from "./bounded-regex.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const configPath = resolve(repoRoot, "gitleaks.toml");

// The marker a Tauri/Minisign private key file actually carries.
//
// `tauri signer generate` writes the untrusted-comment line in PLAINTEXT and only
// the key payload as base64:
//
//     untrusted comment: rsign encrypted secret key
//     RWQ5...base64 of (algorithm || key id || secret key)...
//
// So the plaintext form is the arm that does the work, and requiring it is the
// point of this guard. An earlier version of the rule matched only PREAMBLE_B64,
// on the belief that the preamble appears base64-encoded in a key file. It does
// not, so that rule detected no real Tauri updater key -- measured, not argued:
// against a key file in the shape above it exits 0 having found nothing.
export const PREAMBLE = "untrusted comment: rsign";

// Base64 of the same text, which appears when a key FILE is embedded whole in a
// base64-wrapped CI artifact. Kept as a second arm so that case stays covered.
export const PREAMBLE_B64 = "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu";

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// Length of the string delimiter starting at `pos`: 3 for triple quotes,
// otherwise 1.
function quoteLengthAt(text, pos) {
  return text.startsWith(text[pos].repeat(3), pos) ? 3 : 1;
}

// TOML multiline strings may end with one or two literal delimiter characters
// followed by the closing triple. Consume the complete run (up to five).
function closingQuoteEnd(text, cursor, quote) {
  let end = cursor + quote.length;
  if (quote.length === 3) {
    while (end < cursor + 5 && text[end] === quote[0]) end += 1;
  }
  return end;
}

function startsBasicStringEscape(text, cursor, escapable) {
  return escapable && text[cursor] === "\\";
}

// Index just past the closing delimiter of the string that opens at `pos`,
// or `text.length` when it never closes. Basic (`"`) strings honour
// backslash escapes; literal (`'`) strings do not (TOML v1.0 §strings).
function stringEnd(text, pos) {
  const quote = text.slice(pos, pos + quoteLengthAt(text, pos));
  const escapable = quote[0] === '"';
  let cursor = pos + quote.length;
  while (cursor < text.length) {
    if (startsBasicStringEscape(text, cursor, escapable)) cursor += 2;
    else if (text.startsWith(quote, cursor))
      return closingQuoteEnd(text, cursor, quote);
    else cursor += 1;
  }
  return text.length;
}

// Index of the newline that ends the comment starting at `pos`, or
// `text.length` when the comment runs to EOF. The newline itself is kept.
function commentEnd(text, pos) {
  const eol = text.indexOf("\n", pos);
  return eol === -1 ? text.length : eol;
}

// Drops `#` comments while honouring every TOML string form: basic, literal
// and their multi-line triple-quoted variants. Inside a string a `#` is
// content; outside one it always starts a comment that runs to end of line.
export function stripTomlComments(text) {
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (isTomlQuote(ch)) {
      const end = stringEnd(text, cursor);
      out += text.slice(cursor, end);
      cursor = end;
    } else if (ch === "#") {
      cursor = commentEnd(text, cursor);
    } else {
      out += ch;
      cursor += 1;
    }
  }
  return out;
}

// Index of the first `needle` occurrence that is not inside a TOML string,
// or -1. Markers found inside string values (a regex like
// `foo[allowlist]bar`) are content, not structure, so they must never
// delimit sections.
export function indexOfOutsideStrings(text, needle, from = 0) {
  let cursor = from;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (isTomlQuote(ch)) {
      cursor = stringEnd(text, cursor);
    } else if (text.startsWith(needle, cursor)) {
      return cursor;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

// A line starting with a TOML table header, not a nested array item.
function tableHeaderAt(raw, start) {
  const lineEnd = indexOfOutsideStrings(raw, "\n", start);
  const line = raw.slice(start, lineEnd === -1 ? raw.length : lineEnd).trim();
  return /^\[+[^\]=]+\]+(\s*#.*)?$/.test(line);
}

// Strings and comments cannot contain structural brackets or table boundaries.
function nextStructuralCharacter(raw, from) {
  let cursor = from;
  while (cursor < raw.length) {
    const ch = raw[cursor];
    if (isTomlQuote(ch)) cursor = stringEnd(raw, cursor);
    else if (ch === "#") cursor = commentEnd(raw, cursor);
    else return cursor;
  }
  return cursor;
}

function bracketDepth(depth, ch) {
  if ("[{".includes(ch)) return depth + 1;
  if ("]}".includes(ch)) return Math.max(0, depth - 1);
  return depth;
}

function isTableBoundary(raw, cursor, depth) {
  return (
    raw[cursor] === "\n" &&
    depth === 0 &&
    tableHeaderAt(raw, skipHorizontalSpace(raw, cursor + 1))
  );
}

function nextTableStart(raw, from) {
  let cursor = from;
  let depth = 0;
  while ((cursor = nextStructuralCharacter(raw, cursor)) < raw.length) {
    if (isTableBoundary(raw, cursor, depth)) return cursor;
    depth = bracketDepth(depth, raw[cursor]);
    cursor += 1;
  }
  return -1;
}

function tableBodyStartAt(text, start, header) {
  const at = skipHorizontalSpace(text, start);
  if (!text.startsWith(header, at)) return -1;
  const after = at + header.length;
  const lineEnd = text.indexOf("\n", after);
  const rest = text.slice(after, lineEnd === -1 ? text.length : lineEnd);
  return rest.trim() === "" ? after : -1;
}

// Body of an exact structural table header (for example "[extend]"), not a
// dotted sibling or a mention inside a comment or string.
export function tomlTableBody(raw, header) {
  const text = stripTomlComments(raw);
  for (const start of structuralLineStarts(text)) {
    const after = tableBodyStartAt(text, start, header);
    if (after !== -1) return sectionUntilNextTable(text, after);
  }
  return "";
}

function assignmentMatches(text, valueStart, expected) {
  const value = text.slice(valueStart).trimStart().split(/\s+/)[0] ?? "";
  return value === expected;
}

function isTomlQuote(ch) {
  return ch === '"' || ch === "'";
}

function quotedKeySpan(text, start) {
  const end = stringEnd(text, start);
  const delim = quoteLengthAt(text, start);
  return { end, key: text.slice(start + delim, end - delim) };
}

/** Find an assignment's value after a bare or quoted key at a structural line start. */
function assignmentValueStartAt(text, start, key) {
  if (text.startsWith(key, start))
    return valueStartAfter(text, start + key.length);
  if (!isTomlQuote(text[start])) return -1;
  const span = quotedKeySpan(text, start);
  return span.key === key ? valueStartAfter(text, span.end) : -1;
}

/** Structural line starts, skipping newlines inside quoted TOML values. */
function* structuralLineStarts(text) {
  let start = 0;
  while (start < text.length) {
    yield start;
    const end = indexOfOutsideStrings(text, "\n", start);
    if (end === -1) return;
    start = end + 1;
  }
}

function skipHorizontalSpace(text, start) {
  let cursor = start;
  while (/[ \t]/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function hasAssignment(text, key) {
  return findAssignmentOutsideStrings(text, key) !== -1;
}

// Only an assignment at a structural line start is an option in this table.
// A nested inline table may contain the same key but cannot enable defaults.
function hasUseDefaultValue(text, expected) {
  for (const lineStart of structuralLineStarts(text)) {
    const valueStart = assignmentValueStartAt(
      text,
      skipHorizontalSpace(text, lineStart),
      "useDefault",
    );
    if (valueStart !== -1 && assignmentMatches(text, valueStart, expected)) {
      return true;
    }
  }
  return false;
}

export const hasUseDefaultFalse = (text) => hasUseDefaultValue(text, "false");
const hasUseDefaultTrue = (text) => hasUseDefaultValue(text, "true");

export const hasTopLevelUseDefaultFalse = hasUseDefaultFalse;

// Everything from the first structural `[[rules]]` table to EOF, or null.
export function rulesSection(raw) {
  const start = indexOfOutsideStrings(raw, "[[rules]]");
  return start === -1 ? null : raw.slice(start);
}

// The `regex` value of the tauri-minisign-updater-private-key rule, or null
// when no rule with that id carries a regex. Shared with
// test-secret-history-scan.mjs so both scripts test the same rule. Both the id
// and the value are found with the same string scanner stripTomlComments uses,
// so every TOML string form works, an id or regex line inside a multi-line
// description is content rather than config, and no cross-text quantifier can
// backtrack.
const UPDATER_RULE_ID = "tauri-minisign-updater-private-key";

/**
 * Offset of the first non-blank character of the value of the first `key =`
 * assignment that starts a line and is not inside a string, or -1 when the key
 * has no assignment of that shape. Reusing the string scanner keeps a quoted run
 * from supplying the match, which a plain regex over the text cannot tell apart
 * from a key, and the line-start test is what tells a key from a word like
 * `regexes` in a free-text value.
 */
function findAssignmentOutsideStrings(text, key) {
  for (const lineStart of structuralLineStarts(text)) {
    const value = assignmentValueStartAt(
      text,
      skipHorizontalSpace(text, lineStart),
      key,
    );
    if (value !== -1) return value;
  }
  return -1;
}

/**
 * Offset of the first non-blank character of the value in an assignment whose
 * key ends at `keyEnd`, or -1 when no `=` follows the key. Any run of spaces and
 * tabs is allowed on either side of the `=`, so `regex="..."` and `regex  = "..."`
 * both resolve to their value.
 */
function valueStartAfter(text, keyEnd) {
  let cursor = skipHorizontalSpace(text, keyEnd);
  if (text[cursor] !== "=") return -1;
  cursor += 1;
  return skipHorizontalSpace(text, cursor);
}

// Offset of the quoted value of an assignment at `valueStart`, or -1 when the
// value is not a quoted string. Only a single-character delimiter can open a
// value: a triple-quoted one opens a multi-line string, which is how the prose
// this scanner has to skip is written.
function quotedValueAt(text, valueStart) {
  const quote = text[valueStart];
  if (quote !== '"' && quote !== "'") return null;
  const delimiter = quoteLengthAt(text, valueStart);
  if (delimiter === 3) return null;
  const end = stringEnd(text, valueStart);
  return text.slice(valueStart + delimiter, end - delimiter);
}

function isUpdaterRule(section) {
  const idValueStart = findAssignmentOutsideStrings(section, "id");
  return (
    idValueStart !== -1 &&
    quotedValueAt(section, idValueStart) === UPDATER_RULE_ID
  );
}

function sectionUntilNextTable(text, start) {
  const end = nextTableStart(text, start);
  return text.slice(start, end === -1 ? text.length : end);
}

/** Iterate rule bodies without mixing in child tables or other rules. */
function* ruleSections(rules) {
  const marker = "[[rules]]";
  let start = indexOfOutsideStrings(rules, marker);
  if (start === -1) {
    yield sectionUntilNextTable(rules, 0);
    return;
  }
  while (start !== -1) {
    const bodyStart = start + marker.length;
    yield sectionUntilNextTable(rules, bodyStart);
    start = indexOfOutsideStrings(rules, marker, bodyStart);
  }
}

function updaterRuleSection(rules) {
  for (const section of ruleSections(rules)) {
    if (isUpdaterRule(section)) return section;
  }
  return null;
}

function hasUpdaterKeywords(rules) {
  const section = updaterRuleSection(rules);
  return section !== null && hasAssignment(section, "keywords");
}

export function updaterRulePattern(rules) {
  const section = updaterRuleSection(rules);
  if (section === null) return null;
  const valueStart = findAssignmentOutsideStrings(section, "regex");
  // A missing assignment returns -1; indexing a string there is undefined,
  // which the same quote check rejects as an absent or non-string value.
  if (!isTomlQuote(section[valueStart])) return null;
  const delimiter = quoteLengthAt(section, valueStart);
  if (delimiter === 1) return quotedValueAt(section, valueStart);
  const end = stringEnd(section, valueStart);
  return section.slice(valueStart + delimiter, end - delimiter).trim();
}

/** The global allowlist must not exempt updater keys or misplace useDefault. */
function checkAllowlist(raw) {
  // (a) The preamble must NOT be exempted by the global allowlist.
  const allowlist = tomlTableBody(raw, "[allowlist]");
  for (const marker of [PREAMBLE, PREAMBLE_B64]) {
    if (allowlist.includes(marker)) {
      fail(
        `gitleaks.toml: the updater private-key preamble (${marker}) is still in ` +
          "[allowlist] and would be EXEMPTED from scanning. Move it to a [[rules]] detector.",
      );
    }
  }

  // (d) `useDefault` must NOT be nested inside the [allowlist] section.
  if (hasAssignment(allowlist, "useDefault")) {
    fail(
      "gitleaks.toml: `useDefault` is nested inside [allowlist], where Gitleaks " +
        "ignores it. Remove it from [allowlist].",
    );
  }
}

function hasTopLevelDisabledDefaultRules(raw) {
  const firstTable = indexOfOutsideStrings(raw, "[");
  return hasUseDefaultFalse(firstTable === -1 ? raw : raw.slice(0, firstTable));
}

/** A custom gitleaks config must retain the built-in detection rules. */
function checkDefaultRules(raw) {
  // A custom -c config replaces the built-ins unless [extend] explicitly
  // enables them. Merely omitting useDefault=false is not sufficient.
  // Gitleaks v8.18.0 README: Configuration / [extend].
  if (hasTopLevelDisabledDefaultRules(raw)) {
    fail(
      "gitleaks.toml: remove the ignored top-level useDefault option; enable built-ins under [extend].",
    );
  }
  const extension = tomlTableBody(raw, "[extend]");
  if (!hasUseDefaultTrue(extension) || hasUseDefaultFalse(extension)) {
    fail(
      "gitleaks.toml: explicitly set [extend] useDefault = true so the custom updater rule supplements the built-in detectors.",
    );
  }
}

/** Both supported updater-key encodings need detection. */
function checkPatternMarkers(rulePattern) {
  for (const marker of [PREAMBLE, PREAMBLE_B64]) {
    if (!rulePattern.includes(marker)) {
      fail(
        "gitleaks.toml: the tauri-minisign-updater-private-key regex does not match " +
          `"${marker}". ` +
          (marker === PREAMBLE
            ? "The PLAINTEXT arm is the one that detects a real key: `tauri signer " +
              "generate` writes the untrusted-comment line as text and base64-encodes only " +
              "the key payload, so a rule matching the base64 of that text alone matches no " +
              "real key file."
            : "Keep the base64 arm too, for a key file embedded whole in a base64-wrapped " +
              "CI artifact."),
      );
    }
  }
}

/** Compile the pattern and exercise plaintext and wrapped key fixtures. */
function checkPatternFixtures(rulePattern) {
  // Two fixtures, both shaped like something that actually gets committed.
  //
  // The first is what `tauri signer generate` writes: a plaintext untrusted-comment
  // line, then base64 of the key payload. The previous fixture was
  // `<plaintext line>\n<base64 of the preamble>\n<junk>`, a shape no tool produces
  // and which the previous rule matched -- so it proved the rule matched the
  // fixture rather than that it matched a key.
  const realKey =
    "untrusted comment: rsign encrypted secret key\n" +
    "RWQ5aGF1c2VmaWtlc2VjcmV0a2V5bWF0ZXJpYWxmb3J1cHRlci0y\n";
  // The second is that same file base64-wrapped whole, as a CI artifact carries it.
  const wrappedKey = Buffer.from(realKey, "utf8").toString("base64") + "\n";
  const fixtures = [
    ["a key file", realKey],
    ["a base64-wrapped key file", wrappedKey],
  ];
  let matches;
  try {
    matches = testBoundedRegex(
      rulePattern,
      fixtures.map(([, value]) => value),
    );
  } catch (error) {
    fail(`gitleaks.toml: ${error.message}`);
  }
  for (const [index, [label]] of fixtures.entries()) {
    if (!matches[index]) {
      fail(
        `gitleaks.toml: the configured rule does NOT match ${label} shaped like a ` +
          "committed Tauri updater signing key — key commits would slip through.",
      );
    }
  }
}

function main() {
  // Comments are stripped up front so a `useDefault = false` or `[allowlist]`
  // mention inside a `#` remark can neither trip nor mask a check.
  const raw = stripTomlComments(readFileSync(configPath, "utf8"));

  // What this guard does NOT inspect, so nobody reads its success line as more than it
  // is: `[allowlist] paths`. An entry there can exempt key-shaped files just as
  // effectively as naming the preamble outright -- `'''keys/.*'''` covers every key
  // file in a directory -- and this guard would report that config as clean. It checks the
  // two preamble STRINGS and the shape of the `[[rules]]` block, nothing else.
  //
  // That is a deliberate boundary rather than an oversight. The allowlist lives on the base
  // branch, which is the copy the scan trusts, so a pull request cannot widen it against
  // itself: changing it takes a change to the base branch, reviewed on its own. The gate
  // this guard backs would not get stronger by second-guessing a list it does not own.

  checkAllowlist(raw);
  checkDefaultRules(raw);

  // (b) The preamble MUST be present as a real detection rule's regex.
  const rules = rulesSection(raw);
  if (rules === null) {
    fail("gitleaks.toml: no [[rules]] section found.");
  }
  const rulePattern = updaterRulePattern(rules);
  if (rulePattern === null) {
    fail(
      "gitleaks.toml: could not find regex for id tauri-minisign-updater-private-key.",
    );
  }
  checkPatternMarkers(rulePattern);

  // (c) The updater rule must have NO `keywords` key. A keyword pre-filter is
  // matched against the file's lowercased text before the regex runs, so a keyword
  // that a real key file does not contain suppresses the rule entirely -- which is
  // the same class of defect as a rule that matches nothing.
  if (hasUpdaterKeywords(rules)) {
    fail(
      "gitleaks.toml: the [[rules]] updater-key detector uses `keywords`, which " +
        "pre-filters the file before the regex runs and so can suppress detection " +
        "of a real key. Remove it.",
    );
  }

  checkPatternFixtures(rulePattern);

  console.log(
    "OK: gitleaks.toml config-structure guard passed — the updater private-key " +
      "preamble is a detection rule (not an allowlist exemption), has no " +
      "`keywords` pre-filter, and [extend] explicitly enables the default rule set.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
