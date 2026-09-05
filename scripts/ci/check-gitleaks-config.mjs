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
// nested under `[allowlist]`, and the default rule set must not be switched
// off at the top level. Run with:
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

// Everything from the first structural `[[rules]]` table to EOF, or null.
export function rulesSection(raw) {
  const start = indexOfOutsideStrings(raw, "[[rules]]");
  return start === -1 ? null : raw.slice(start);
}

// The `regex` value of the tauri-minisign-updater-private-key rule, or null
// when no rule with that id carries a regex. Shared with
// test-secret-history-scan.mjs so both scripts test the same rule. The id is
// matched line-anchored, and the value is read with the same string scanner
// stripTomlComments uses, so every TOML string form works and no cross-text
// quantifier can backtrack.
export function updaterRulePattern(rules) {
  const idMatch = /^id\s*=\s*"tauri-minisign-updater-private-key"\s*$/m.exec(
    rules,
  );
  if (!idMatch) return null;
  const afterId = rules.slice(idMatch.index + idMatch[0].length);
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

  // (e) A top-level `useDefault = false` disables every built-in Gitleaks rule
  // and silently weakens the whole-repo scan to the single updater-key rule.
  const firstTable = indexOfOutsideStrings(raw, "[");
  const topLevel = firstTable === -1 ? raw : raw.slice(0, firstTable);
  const useDefaultDisabled = topLevel
    .split("\n")
    .some((line) => /^useDefault\s*=\s*false\b/.test(line.trim()));
  if (useDefaultDisabled) {
    fail(
      "gitleaks.toml: top-level `useDefault = false` disables the default " +
        "rule set. Remove it so the whole-repo scan keeps the built-in detectors.",
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
  if (rules.includes("keywords")) {
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
      "`keywords` pre-filter, `useDefault` is not nested in [allowlist], and " +
      "the default rule set stays enabled.",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
