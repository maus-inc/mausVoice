// Verifies the Gitleaks configuration actually guards the Tauri/Minisign
// updater private-key preamble instead of exempting it, and proves a fixture
// containing that preamble would be flagged by the configured rule.
//
// This is the CI guard for the security finding that the updater-key preamble
// had been placed under `[allowlist].regexes`, which *exempted* it (and, by
// allowlisting every workflow, also exempted a key committed inside a
// workflow). Run with: node scripts/ci/check-gitleaks-config.mjs

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

// 1. The preamble must NOT be exempted by the global allowlist.
const allowlist = section(raw, "[allowlist]", "[[rules]]");
if (allowlist.includes(PREAMBLE_B64)) {
  fail(
    "gitleaks.toml: the updater private-key preamble is still in [allowlist] " +
      "and would be EXEMPTED from scanning. Move it to a [[rules]] detector.",
  );
}
if (allowlist.includes(String.raw`\.github/workflows/`)) {
  fail(
    "gitleaks.toml: workflows are globally allowlisted, so a literal updater " +
      "key committed in a workflow would evade scanning.",
  );
}

// 2. The preamble MUST be present as a real detection rule.
const rules = raw.slice(raw.indexOf("[[rules]]"));
if (!rules.includes(PREAMBLE_B64)) {
  fail(
    "gitleaks.toml: no [[rules]] detector matches the updater private-key " +
      "preamble. Add a [[rules]] entry with the preamble base64 as its regex.",
  );
}

// 3. Extract the rule regex and prove it fires on a fixture containing the
//    preamble (i.e. real Gitleaks would exit non-zero on such a file).
const ruleMatch = rules.match(/regex\s*=\s*'''?([^']*)'''?/);
if (!ruleMatch) {
  fail("gitleaks.toml: could not parse the [[rules]] regex value.");
}
const pattern = ruleMatch[1].trim();

let re;
try {
  re = new RegExp(pattern);
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
  "OK: gitleaks.toml detects the Tauri/Minisign updater private-key preamble " +
    "and does not exempt it (or workflows) via the allowlist.",
);
