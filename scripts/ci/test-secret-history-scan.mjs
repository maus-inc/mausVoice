// Integration test: prove the Gitleaks updater-key scanner catches an
// add-then-delete secret (added in commit A, deleted in commit B, final tree
// clean) — the exact regression M4 fixes. It also guards that a Base64-only
// updater key is detected at all.
//
// Runs in two phases:
//   1. Offline (always): asserts the configured [[rules]] regex would match a
//      A real key file and a base64-wrapped one. This validates
//      the gitleaks.toml wiring without any network or binary.
//   2. Live (with gitleaks at a trusted install path): builds a throwaway git repo with an
//      add-then-delete key, runs `gitleaks detect` over its history, and
//      asserts the scan FAILS (i.e. catches the deleted secret). It also
//      asserts a clean final tree alone would PASS, proving history scanning
//      is what catches the add-then-delete case.
//
// Run with: node scripts/ci/test-secret-history-scan.mjs

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  rulesSection,
  stripTomlComments,
  updaterRulePattern,
} from "./check-gitleaks-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const configPath = resolve(repoRoot, "gitleaks.toml");
const configRaw = readFileSync(configPath, "utf8");

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

// ---- Parse the [[rules]] detection regex from gitleaks.toml ----
const rules = rulesSection(stripTomlComments(configRaw));
if (rules === null) fail("gitleaks.toml: could not find a [[rules]] section.");
const rulePattern = updaterRulePattern(rules);
if (rulePattern === null)
  fail("gitleaks.toml: could not find the updater-key rule regex value.");
let re;
try {
  re = new RegExp(rulePattern);
} catch (err) {
  fail(`gitleaks.toml: rule regex is not valid: ${err.message}`);
}

// ---- Phase 1: offline regex assertions ----
// What `tauri signer generate` actually writes: the untrusted-comment line in
// plain text, then base64 of the key payload. The previous fixture was
// `<plaintext line>\n<base64 of that line>\n`, a shape no tool produces, which the
// previous base64-only rule matched -- so it proved the rule matched the fixture,
// not that it matched a key.
const realKeyFixture =
  "untrusted comment: rsign encrypted secret key\n" +
  "RWQ5aGF1c2VmaWtlc2VjcmV0a2V5bWF0ZXJpYWxmb3J1cHRlci0y\n";
// The same file base64-wrapped whole, as a CI artifact would carry it.
const wrappedKeyFixture =
  Buffer.from(realKeyFixture, "utf8").toString("base64") + "\n";
// A THIRD fixture used to live here, and it was a real key.
//
// `fullKeyFixture` was a minisign private key whose decoded bytes are identical -- all 259
// of them, sha256 8437454a207d5a4b -- to the `TAURI_SIGNING_PRIVATE_KEY` this branch REMOVES
// from `.github/workflows/build-desktop.yml`. That key is a documented throwaway ("the
// repo-visible throwaway CI key", release.yml) used to sign CI artifacts that publish no
// `latest.json`, and it is already in the repository's history, so this leaked nothing new.
//
// It still meant that a pull request whose purpose includes keeping key material out
// re-added that key material under a new path, and then added an allowlist entry for that
// path -- so the scan this branch turns back on could not report it.
//
// `realKeyFixture` above proves the same property: the plaintext arm of the rule matches
// it. A third copy added no coverage the first two did not already give.

const MATCHES = [
  ["a real key file", realKeyFixture],
  ["a base64-wrapped key file", wrappedKeyFixture],
];
for (const [label, fixture] of MATCHES) {
  if (!re.test(fixture)) fail(`Rule regex does NOT match ${label}.`);
}
// Built from the list, not written out. The previous version was a literal naming three
// fixtures, one of which this change deleted -- so the line reported on something the file
// no longer carried. Anything derived from the thing it describes cannot say that.
console.log(
  `OK (offline): gitleaks.toml rule matches ${MATCHES.map(([l]) => l).join(", ")}.`,
);

// Add-then-delete simulation (offline): commit A adds the key, commit B deletes
// it, so the final tree is clean. A tree-only scan (the old `--no-git`) would
// see an empty tree and PASS, while a full-history scan sees commit A's content
// and MUST fail. This is the exact regression M4 fixes.
const commitA = realKeyFixture; // key present
const finalTree = ""; // commit B removed it
if (!re.test(commitA))
  fail("Simulation: history (commit A) did not contain a detectable key.");
if (re.test(finalTree))
  fail("Simulation: clean final tree unexpectedly contained the key.");
console.log(
  "OK (offline): add-then-delete simulation — history contains the key, clean final tree does not (history scan required).",
);

// ---- Phase 2: live add-then-delete history scan (requires `gitleaks`) ----
// Gitleaks and git are invoked via absolute paths so neither binary is ever
// resolved through a possibly-attacker-controlled PATH (S4036).
const GITLEAKS_CANDIDATES = [
  "/usr/local/bin/gitleaks",
  "/usr/bin/gitleaks",
  "/opt/homebrew/bin/gitleaks",
];
const GIT_BIN = "/usr/bin/git";
let gitleaks = null;
for (const candidate of GITLEAKS_CANDIDATES) {
  try {
    execFileSync(candidate, ["version"]);
    gitleaks = candidate;
    break;
  } catch {
    // try the next allowlisted absolute path
  }
}
if (!gitleaks) {
  const missing = `No runnable gitleaks at ${GITLEAKS_CANDIDATES.join(", ")}.`;
  if (process.argv.includes("--require-live")) fail(missing);
  console.log(`SKIP (live): ${missing} Only the offline assertions ran.`);
  process.exit(0);
}

const tmp = mkdtempSync(resolve(tmpdir(), "gitleaks-hist-"));
try {
  const repo = resolve(tmp, "repo");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync(GIT_BIN, args, { cwd: repo, encoding: "utf8" });

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");

  // Commit A: add a file containing a hardcoded updater key.
  writeFileSync(resolve(repo, "ci-key.txt"), realKeyFixture);
  git("add", "ci-key.txt");
  git("commit", "-q", "-m", "add key");

  const addedIn = git("rev-parse", "HEAD").trim();

  // Commit B: delete it — final tree is now clean.
  git("rm", "-q", "ci-key.txt");
  git("commit", "-q", "-m", "remove key");

  // Use a distinct findings exit code. A parse or git error is not a detection.
  // Keep the report outside the tree that the clean-tree control scans next.
  const report = resolve(tmp, "findings.json");
  const scan = (...args) =>
    spawnSync(
      gitleaks,
      [
        "detect",
        "--source",
        repo,
        "-c",
        configPath,
        "--redact",
        "--exit-code",
        "23",
        ...args,
      ],
      { cwd: repo, encoding: "utf8" },
    );
  const history = scan("--report-format", "json", "--report-path", report);
  if (history.status !== 23)
    throw new Error(`Expected a history finding, got exit ${history.status}.`);
  const findings = JSON.parse(readFileSync(report, "utf8"));
  if (
    !findings.some(
      (f) =>
        f.RuleID === "tauri-minisign-updater-private-key" &&
        f.File === "ci-key.txt" &&
        f.Commit === addedIn,
    )
  )
    throw new Error(
      "The updater rule did not identify the file in its adding commit.",
    );
  if (scan("--no-git").status !== 0)
    throw new Error("The clean final tree did not pass the scanner.");
  console.log(
    "OK (live): the updater rule found the deleted fixture in its adding commit; its final tree passed.",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS: secret history-scan integration test succeeded.");
