// Config-structure guard for gitleaks.toml.
//
// NOTE: This is NOT a secret scanner. It does not (and cannot) detect secrets.
// It only asserts that gitleaks.toml is wired so that REAL Gitleaks, when run
// (see .github/workflows/secret-scan.yml), will actually detect a Base64-only
// Tauri/Minisign updater private-key preamble rather than exempting it.
//
// It guards the structure of the config: the preamble must be a detection rule
// (not an allowlist exemption), must not carry a `keywords` pre-filter that
// would short-circuit Base64-only keys, and `useDefault` must not be wrongly
// nested under `[allowlist]`. Run with:
//   node scripts/ci/check-gitleaks-config.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const configPath = resolve(repoRoot, "gitleaks.toml");
const raw = readFileSync(configPath, "utf8");

// Base64 of "untrusted comment: rsign" — the first line of every Tauri/Minisign
// private key file. This is the exact string the detection rule must match.
const PREAMBLE_B64 = "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu";

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";
  const after = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, after) : -1;
  return end === -1 ? text.slice(after) : text.slice(after, end);
}

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

// (b) The preamble MUST be present as a real detection rule's regex.
const rules = raw.slice(raw.indexOf("[[rules]]"));
const ruleRegexMatch = rules.match(/regex\s*=\s*'''?([^']*)'''?/);
if (!ruleRegexMatch) {
  fail("gitleaks.toml: could not find a [[rules]] regex value.");
}
if (!ruleRegexMatch[1].includes(PREAMBLE_B64)) {
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
  re = new RegExp(ruleRegexMatch[1].trim());
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
    "`keywords` pre-filter, and `useDefault` is not nested in [allowlist].",
);
