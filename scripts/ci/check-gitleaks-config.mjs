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

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const configPath = resolve(repoRoot, "gitleaks.toml");

// Base64 of "untrusted comment: rsign" — the first line of every Tauri/Minisign
// private key file. This is the exact string the detection rule must match.
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

// Index just past the closing delimiter of the string that opens at `pos`,
// or `text.length` when it never closes. Basic (`"`) strings honour
// backslash escapes; literal (`'`) strings do not (TOML v1.0 §strings).
function stringEnd(text, pos) {
  const quote = text.slice(pos, pos + quoteLengthAt(text, pos));
  const escapable = quote[0] === '"';
  let cursor = pos + quote.length;
  while (cursor < text.length) {
    if (escapable && text[cursor] === "\\") cursor += 2;
    else if (text.startsWith(quote, cursor)) return cursor + quote.length;
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
    if (ch === '"' || ch === "'") {
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
    if (ch === '"' || ch === "'") {
      cursor = stringEnd(text, cursor);
    } else if (text.startsWith(needle, cursor)) {
      return cursor;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

function section(text, startMarker, endMarker) {
  const start = indexOfOutsideStrings(text, startMarker);
  if (start === -1) return "";
  const after = start + startMarker.length;
  const end = endMarker ? indexOfOutsideStrings(text, endMarker, after) : -1;
  return end === -1 ? text.slice(after) : text.slice(after, end);
}

function nextTableStart(raw, from) {
  let cursor = from;
  while (cursor < raw.length) {
    const newline = indexOfOutsideStrings(raw, "\n", cursor);
    if (newline === -1) return -1;
    cursor = newline + 1;
    while (raw[cursor] === " " || raw[cursor] === "\t") cursor += 1;
    if (raw[cursor] === "[") {
      const lineEnd = indexOfOutsideStrings(raw, "\n", cursor);
      const line = (
        lineEnd === -1 ? raw.slice(cursor) : raw.slice(cursor, lineEnd)
      ).trim();
      if (/^\[+[^\]=]+\]+(\s*#.*)?$/.test(line)) {
        return newline;
      }
    }
  }
  return -1;
}

// Body of a TOML table whose header is exactly `header` (for example
// "[extend]"), not a dotted sibling like "[extend.foo]". Empty when the
// table is absent.
export function tomlTableBody(raw, header) {
  let from = 0;
  while (from <= raw.length) {
    const at = indexOfOutsideStrings(raw, header, from);
    if (at === -1) return "";
    const after = at + header.length;
    const next = raw[after];
    if (
      next !== undefined &&
      next !== "\r" &&
      next !== "\n" &&
      !/[ \t]/.test(next)
    ) {
      from = at + 1;
      continue;
    }
    const end = nextTableStart(raw, after);
    return end === -1 ? raw.slice(after) : raw.slice(after, end);
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

function quotedKeyMatches(text, end, expected) {
  const rest = text.slice(end);
  const eq = /^\s*=\s*/.exec(rest);
  if (!eq) return false;
  return assignmentMatches(rest, eq[0].length, expected);
}

function isBareUseDefaultKey(text, cursor) {
  if (!text.startsWith("useDefault", cursor)) return false;
  const before = text[cursor - 1];
  const after = text[cursor + "useDefault".length];
  const boundBefore = before === undefined || /[\s=]/.test(before);
  const boundAfter = after === undefined || /[\s=]/.test(after);
  return boundBefore && boundAfter;
}

function bareUseDefaultAt(text, cursor, expected) {
  const eq = indexOfOutsideStrings(text, "=", cursor + "useDefault".length);
  if (eq === -1) return { next: -1, matches: false };
  return { next: eq + 1, matches: assignmentMatches(text, eq + 1, expected) };
}

// Match an explicit boolean assignment to the real useDefault key,
// including quoted keys. Prose like
// `description = """ ... useDefault = false ... """` is content, not config,
// and must never trip the guard (a false positive would block CI over a
// comment).
function hasUseDefaultValue(text, expected) {
  let cursor = 0;
  while (cursor < text.length) {
    if (isTomlQuote(text[cursor])) {
      const start = cursor;
      const { end, key } = quotedKeySpan(text, start);
      if (key === "useDefault" && quotedKeyMatches(text, end, expected)) {
        return true;
      }
      cursor = Math.max(end, start + 1);
      continue;
    }
    if (isBareUseDefaultKey(text, cursor)) {
      const { next, matches } = bareUseDefaultAt(text, cursor, expected);
      if (next === -1) return false;
      if (matches) return true;
      cursor = next;
      continue;
    }
    cursor += 1;
  }
  return false;
}

export const hasUseDefaultFalse = (text) => hasUseDefaultValue(text, "false");
export const hasUseDefaultTrue = (text) => hasUseDefaultValue(text, "true");

export const hasTopLevelUseDefaultFalse = hasUseDefaultFalse;

// Everything from the first structural `[[rules]]` table to EOF, or null.
export function rulesSection(raw) {
  const start = indexOfOutsideStrings(raw, "[[rules]]");
  return start === -1 ? null : raw.slice(start);
}

// The `regex` value of the tauri-minisign-updater-private-key rule, or null
// when no rule with that id carries a regex. Shared with
// test-secret-history-scan.mjs so both scripts test the same rule. The id
// line is matched per-line (trimmed, either quote style, any indentation),
// and the value is read with the same string scanner stripTomlComments uses,
// so every TOML string form works and no cross-text quantifier can
// backtrack.
const UPDATER_RULE_ID_LINE =
  /^id\s*=\s*["']tauri-minisign-updater-private-key["']\s*$/;

export function updaterRulePattern(rules) {
  const lines = rules.split("\n");
  const idLineIndex = lines.findIndex((line) =>
    UPDATER_RULE_ID_LINE.test(line.trim()),
  );
  if (idLineIndex === -1) return null;
  const afterIdLine = lines.slice(idLineIndex + 1).join("\n");
  // The regex must belong to the updater rule itself. Stop at the next
  // [[rules]] table so a regex from a later rule is never attributed to it.
  const nextRulesTable = indexOfOutsideStrings(afterIdLine, "[[rules]]");
  const afterId =
    nextRulesTable === -1 ? afterIdLine : afterIdLine.slice(0, nextRulesTable);
  const keyMatch = /^[ \t]*regex[ \t]*=[ \t]*/m.exec(afterId);
  if (!keyMatch) return null;
  const valueStart = keyMatch.index + keyMatch[0].length;
  const quote = afterId[valueStart];
  if (quote !== '"' && quote !== "'") return null;
  const valueEnd = stringEnd(afterId, valueStart);
  const delimiter = quoteLengthAt(afterId, valueStart);
  return afterId.slice(valueStart + delimiter, valueEnd - delimiter).trim();
}

function main() {
  // Comments are stripped up front so a `useDefault = false` or `[allowlist]`
  // mention inside a `#` remark can neither trip nor mask a check.
  const raw = stripTomlComments(readFileSync(configPath, "utf8"));

  // (a) The preamble must NOT be exempted by the global allowlist.
  const allowlist = section(raw, "[allowlist]", "[[rules]]");
  if (allowlist.includes(PREAMBLE_B64)) {
    fail(
      "gitleaks.toml: the updater private-key preamble is still in [allowlist] " +
        "and would be EXEMPTED from scanning. Move it to a [[rules]] detector.",
    );
  }

  // (d) `useDefault` must NOT be nested inside the [allowlist] section.
  if (allowlist.includes("useDefault")) {
    fail(
      "gitleaks.toml: `useDefault` is nested inside [allowlist], where Gitleaks " +
        "ignores it. Remove it from [allowlist].",
    );
  }

  // A custom -c config replaces the built-ins unless [extend] explicitly
  // enables them. Merely omitting useDefault=false is not sufficient.
  // Gitleaks v8.18.0 README: Configuration / [extend].
  const firstTable = indexOfOutsideStrings(raw, "[");
  const topLevel = firstTable === -1 ? raw : raw.slice(0, firstTable);
  if (hasUseDefaultFalse(topLevel)) {
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
  if (!rulePattern.includes(PREAMBLE_B64)) {
    fail(
      "gitleaks.toml: no [[rules]] detector regex matches the updater " +
        "private-key preamble. Add the preamble base64 as the rule regex.",
    );
  }

  // (c) The [[rules]] block must have NO `keywords` key, which would
  // short-circuit detection of a Base64-only key (no plaintext "rsign").
  if (/^\s*keywords\s*=/m.test(rules)) {
    fail(
      "gitleaks.toml: the [[rules]] updater-key detector uses `keywords`, which " +
        "would short-circuit detection of a Base64-only key. Remove it.",
    );
  }

  // Prove the rule regex (captured via the [^']* pattern from the prior
  // SonarCloud fixes) actually fires on a fixture containing the preamble,
  // so real Gitleaks would exit non-zero on such a file.
  let re;
  try {
    re = new RegExp(rulePattern);
  } catch (err) {
    fail(`gitleaks.toml: rule regex is not valid: ${err.message}`);
  }

  // A fake private key: the untrusted-comment preamble (base64 form) followed by
  // junk. This mirrors the first line of a committed Tauri signing key.
  const fixture = `untrusted comment: rsign\n${PREAMBLE_B64}\nRWRfakesecretkeymaterialforupdaterforgerytesting==\n`;
  if (!re.test(fixture)) {
    fail(
      "gitleaks.toml: the configured rule does NOT match a fixture containing " +
        "the updater private-key preamble — key commits would slip through.",
    );
  }

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
