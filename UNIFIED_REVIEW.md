# mausVoice — Assertive Multi-Agent Pre-Merge Review (CodeRabbit profile, REVIEW.md §1.1/§2)

**Meta**

- **Repo / target:** `maus-inc/mausVoice` (Tauri desktop dictation; Rust backend + React/TS frontend; pnpm/Turborepo).
- **Scope:** consolidated pre-merge review of the 5 open arena PRs — #55, #57, #58, #59, #60.
- **Profile:** CodeRabbit assertive audit posture (REVIEW.md §1.1) + seven-section report structure (§2.5). Severity scale: 🔴 Critical · 🟠 Major · 🟡 Minor · 🔵 Nitpick.
- **Ensemble limitation (stated honestly):** the requested "ensemble of 7–8 distinct models + 4 free models" could not be run as literally separate model backends — this harness exposes a single model for subagents. The ensemble was **emulated** via 8 distinct reviewer lenses/personas: 5 per-PR deep reviewers, 1 Security/SAST lens, 1 Architecture/Concurrency lens, and this Synthesis lens. Each lens applied the §2.2 self-review gate (Cause → Action → Reaction → Necessity) and traced the §2.4 ten-point coverage checklist. Findings below are therefore *lens-divergent analyses of one model*, not cross-model consensus; confidence tags reflect that.
- **Reviews already on these PRs:** findings are cross-checked against the existing `coderabbitai` and `kilo-code-bot` reviews/comments (see §6).

---

## 2. Program Verdict

**Overall readiness: NOT READY to merge as a batch. Confidence: HIGH for the verdict, MEDIUM for #60 (CI pending) and #55 (CI pending).**

None of the five PRs should merge in their current state except **#58**, which is **Ready** (the one genuinely mergeable branch, pending one non-blocking release gate). The other four each carry at least one release-blocking 🔴 or 🟠 defect.

**The single most important blocker is PR #57's popout SPA duplication (🔴 Critical):** the Composer webview loads the *entire* SPA, so `DictationSideEffects`/`AppSideEffects` run inside the popout and the broadcast `keys_held` event triggers a **second `start_recording` cycle** in the popout — double transcription and double paste on every dictate hotkey. This is a functional correctness defect that no earlier reviewer flagged, and it intersects with #58's `http:default` wildcard to produce the worst-case IPC-capable, over-egress popout.

**Merge strategy (do not squash-merge blindly):** follow the conflict-driven ordering in §5 — `#55 → #57 → #60 (rebase) → #58 → #59`. #57 and #60 share 11 files and **will not auto-merge**; they must be reconciled around a single hotkey combo evaluator.

---

## 3. Per-PR Sections

### PR #55 — "harden local model artifact downloads" (Rust sidecar)

- **Verdict:** `## Verdict: **Not Ready**` · `Confidence: **High**` · `Mergeable: **Yes**` · `CI Verification: **Pending**`
- **Files:** `packages/rust_transcription/src/downloads.rs`, `onnx_inference.rs`.

🔴 **MAJOR — Integrity policy bypassed for pre-existing artifacts.** `download_artifact` (downloads.rs:528) and `start_or_get_active` (via `existing_artifact_set_size`:146) accept **any non-empty destination file** as `Completed` **without** checking `max_bytes` or `sha256`. `validate_model_classified` (onnx_inference.rs:131) only confirms the ONNX graph loads — it never compares a digest. A model downloaded *before* this change (under the old mutable `resolve/main/` URLs) is trusted forever and never re-verified, silently bypassing the new SHA-256 trust boundary for the most common real case (app upgrade reusing a prior model). A prior reviewer marked this **"Addressed" — the code shows it is NOT.**
*Solution:* apply the same admission gate (size + sha256) to both shortcut paths; remove + re-download if not admitted. `<details>` prompt: extend `existing_artifact_set_size` / `download_artifact` early-return to run the same `max_bytes`+`sha256` check used on the full download path; add a unit test that pre-seeds a non-empty file with wrong size and asserts it is rejected/redownloaded.

🟡 **MINOR — oversized chunk written before cap enforced.** `downloaded` is incremented **after** `write_all` (downloads.rs:649), so a giant chunk is fully buffered to disk before detection. Predict the cap before writing. `<details>` prompt: check `downloaded + chunk.len() > max_bytes` before `write_all`.

🟡 **MINOR — pinned digests never validated against upstream.** No CI check that the committed SHA-256 constant matches the bytes at the pinned revision; a single wrong character is a permanent download failure with no recovery. `<details>` prompt: add a scheduled CI job that refetches pinned artifacts and compares digests.

✅ **What is working correctly (strong):** redirect policy correct (https only, 5-hop cap, HF allow-list suffix-matching rejects look-alikes, subsuming the regional-host suggestion); size cap enforced in 3 places (Content-Length + resume remaining-byte + per-chunk) with safe `usize`/`u64` casts; SHA-256 post-download via `spawn_blocking`, removes temp+validator on mismatch, never renames a bad file; partial cleanup on all breach/cancel paths; companion artifacts sequential with `?` propagation (no fire-and-forget, satisfies §3.9); pinning/override-removal correct; TS abort propagation fixed (`withTimeout` → `controller.abort` → Groq fallback short-circuit); CI filter widened per §5.3. **Security posture is net-positive.**

### PR #57 — "Implement feature expansion plan" (LARGEST, HIGHEST RISK)

- **Verdict:** `## Verdict: **Request Changes**` · `Confidence: **High**` · `Mergeable: **No**` (conflict with #60) · `CI Verification: **Passing (green, but cannot exercise new runtime paths)**`
- **Files:** `apps/desktop/src-tauri/src/...`, `app.rs`, `examples/gen_bindings.rs`, `bindings.ts`, `packages/rust_transcription/src/onnx_inference.rs`, plus 89 files.

🔴 **CRITICAL — Composer popout loads the entire SPA.** `floating_window_create` opens `WebviewUrl::App("composer?requestId=…")`, so `AppSideEffects` + `DictationSideEffects` run in the popout. `keys_held` is broadcast via `emit_to(EventTarget::any(), …)`, so the popout store gets identical key state → the dictate hotkey triggers **TWO `start_recording` cycles** (main + popout) = double transcription + double paste.
*Solution:* isolate `ComposerPage` (no `DictationSideEffects`/`AppSideEffects`/tray) **or** scope the `keys_held` broadcast to the main window and gate the pipeline on `window.label === "main"`. `<details>` prompt: in the popout window creation, mount only `ComposerPage`; change `keys_held` emit target to `EventTarget::window("main")` and add `if window.label() != "main" { return; }` to the dictation pipeline entry.

🔴 **CRITICAL (build/contract) — IPC bindings drift.** `transcription_import_audio` + 4 `composer_*` commands are registered in `app.rs` but **ABSENT** from `examples/gen_bindings.rs` `collect_commands`. The frontend calls them via raw `invoke()`; the hand-added `bindings.ts:853` entry is orphaned. Running `pnpm gen:bindings` **removes** it → guaranteed future desync.
*Solution:* add all 5 commands to `collect_commands`, regen bindings, route through `commands.*` in a repo. `<details>` prompt: append the 5 command names to `collect_commands!()` in `examples/gen_bindings.rs`, run `pnpm gen:bindings`, replace raw `invoke("composer_*")` calls with `commands.composer_*`.

🔴 **CRITICAL (silent runtime risk) — ONNX/SenseVoice runtime unpinned/unverified.** `onnx_inference.rs` resolves the ORT dylib from env/executable_dir with **NO version pin + NO integrity check**. CI only *compiles* the sidecar, never runs SenseVoice. Silent "loads but no output" on first use = release risk.
*Solution:* pin the ORT version, validate the dylib (size/digest/presence) with a clear error, add a smoke test. `<details>` prompt: gate model activation on a `verify_ort_runtime()` returning a typed error surfaced to the UI.

🟠 **MAJOR — `run_terminal_command` allow-list includes `cat` (see §4 risk #1).** `validate_terminal_command_args` forbids shell metachars but **not** `/` or `..`, so `cat /etc/passwd`, `cat ~/.ssh/id_rsa`, `cat ../../secrets` all execute. The Rust command is IPC-callable regardless of the UI power-mode gate → prompt-injected agent exfil path. Fix: drop `cat` or canonicalize to an allowed read-root; forbid `/` and `..` in args; consider gating the command on power mode.

🟠 **MINOR — hallucination filter default-on & language-agnostic.** Exact-match strips legitimate sentences (e.g. "Thank you for watching.") and any non-English transcript containing an English phrase. Gate by language.

🟠 **MINOR — `agentEnabledTools` null vs `[]` dual meaning.** `null` = registry default enable-all; `[]` = explicit deny. Error-prone; migration `null`→`[all]` could silently re-enable denied tools.

🟠 **MINOR — in-dictation style switch retags finalized segment with LATEST language/style, not the one captured.** Snapshot at segment start.

🟡 **MINOR — `composer_take_text` is dead code** (defined + registered, never called).

🟡 **MINOR — voice Edit Mode silently no-ops on non-Chromium webviews** (`webkitSpeechRecognition` undefined on Linux webkitgtk) with no detection/feedback.

🟡 **MINOR — i18n extraction not verified** for new composer/agent strings.

🔵 **NITPICK — popout `always_on_top` + focus-restore risk; `StyleHotkeysDialog` rows rebuild on `hotkeyById` change.**

✅ **What is working correctly:** the `..` route-guard bypass is **FIXED** (`validate_local_app_route` rejects literal + `%2e%2e`; composer text via Rust state keyed by `requestId` eliminates the URL-injection vector) — credit due; DB migrations clean (irregular numbering, sane defaults); security surface disciplined (tauri-plugin-dialog scoped; CSP untouched; `dangerousDisableAssetCspModification` stays `["style-src"]`); hallucination filter has real tests; CI green; no XSS (`dangerouslySetInnerHTML` absent from new components).

### PR #58 — "resolve pre-release audit findings"

- **Verdict:** `## Verdict: **Ready**` · `Confidence: **High**` · `Mergeable: **Yes**` · `CI Verification: **Passing** (per author + independent contract-test reproduction)`
- **One open manual item (bundled smoke test) is a release gate, not a merge blocker.**

🟠 **MAJOR (security, debated) — `http:default` capability widened to wildcards.** `capabilities/default.json:89-98` now allows `http://*:*` / `https://*` / `https://*/**`, replacing the enumerated SaaS allowlist. **Not** a §3.6 `remote.urls` IPC re-exposure (`remote.urls` stayed loopback-only), but a least-privilege regression for the plugin-http Rust egress.
*Solution:* keep `http://*` for LAN/Ollama, replace `https://*` with a curated provider list (or derive from `connect-src`); add a TS-side host allowlist wrapper. `<details>` prompt: enumerate the provider hosts already present in `connect-src` into `http:default` and drop the bare `https://*` catch-all.

🟡 **MINOR — contract test `SCAN_ROOTS` only covers `apps/desktop/src` + `packages/voice-ai/src`** (not `packages/agent`, `desktop-utils`, etc.) → false confidence. Widen.

🟡 **MINOR — whole-file skip on plugin-http import** can mask a bare `fetch` in the same file. Classify per call-site.

🔵 **NITPICK — `schema.tauri.app` special-cased in staleness check (fragile).** Move to a constant.

✅ **What is working correctly (strong):** `connect-src` additions verified real (`api.assemblyai.com`, `api.x.ai`, `api.aldea.ai`, `*.stt.speech.microsoft.com`); contract test is **not** tautological (mutation check fails when a host is removed); `remote.urls` correctly loopback-only; release.yml token guard correct (removed `GITHUB_TOKEN` fallback); `verify-rust` widened to `rust_transcription`/`rust_pill_shared`/`rust_gtk_pill` with xvfb; REVIEW.md dedupe clean (one coherent copy); `asset:` → `asset.localhost` corrected.

### PR #59 — "working end-to-end auto-update pipeline"

- **Verdict:** `## Verdict: **Not Ready**` · `Confidence: **High**` (static + simulated manifest builds; not a live release) · `Mergeable: **No**` · `CI Verification: **Pending**`

🔴 **CRITICAL — Windows updater dead on arrival.** v2 `createUpdaterArtifacts` emits `.msi`/`.exe`+`.sig`, **not** `.nsis.zip`, so the manifest builder (`build-updater-manifest.mjs:36` matches `.nsis.zip`) emits **no `windows-x86_64` key**. AND `get_urls()` runs **before** `should_update()` in `tauri-plugin-updater`, so a missing key → `TargetsNotFound` → **permanent "Could not check for updates" error** (not a silent no-op).
*Solution:* v1-compatible or per-installer keys (`windows-x86_64-nsis`/`-msi`) + update `release.yml` globs. `<details>` prompt: switch `createUpdaterArtifacts` to emit `.nsis.zip` (or add explicit per-key entries) so the manifest matches the plugin's expected key names.

🟠 **MAJOR — Linux `.deb`/`.rpm` fall through to AppImage URL → `InvalidUpdaterFormat`.** Emit `linux-x86_64-deb`/`-rpm`.

🟠 **MAJOR — `generate-release-body.mjs` `classify()` matches "setup" substring**, so `*.exe.sig` lists as a Windows installer download. Exclude `*.sig`.

🟠/🟡 **MAJOR/MINOR — macOS manual-install URL is `.pkg` but v2 makes `.dmg`; `validate_installer_url` hard-requires `.pkg`.** Use `.dmg` + relax validator.

🟠 **VERIFY — personal-fork-ci workflows use YAML anchors** (GitHub may reject). The PR body claimed workflows "could NOT be pushed" yet they're on the branch — verify they parse.

🟡 **MINOR — Docs contradict fail-closed behavior.** `RELEASE.md` / `auto-update.md` say "degrade gracefully" but `release.yml:418` fails closed. Reconcile docs.

🟡 **MINOR — `GITHUB_REPOSITORY` fork fallback** points the manifest at the wrong repo.

✅ **What is working correctly (genuinely good):** **no committed signing key/pubkey literal** — §5.5 Critical from main is FIXED (`pubkey:""` + `createUpdaterArtifacts:false`; keys in secrets only); endpoint corrected to `maus-inc/mausVoice` (was `mausvoice/mausvoice`); `latest.json` now produced with 9/9 tests; macOS + Linux-AppImage entries correct; startup dismiss regression fixed; dev skip + 6h poll + tray badge sync correct; least-privilege workflows.

### PR #60 — "resolve all 50 CodeFactor issues" (BEHAVIOR-PRESERVING REFACTOR claim)

- **Verdict:** `## Verdict: **Not Ready**` · `Confidence: **Medium**` (CI pending) · `Mergeable: **No**` (conflict with #57) · `CI Verification: **Pending**`

🔴 **MAJOR (functional) — 3 new user-facing strings missing from the i18n catalog:** `Device role` (MultiDeviceDialog.tsx:309), `Device platform` (:326), `Select or type a model` (FreeSoloModelAutocomplete.tsx:44). Violates AGENTS.md i18n rule; breaks non-en locales **and the CI i18n gate**. Prior reviewers (`coderabbitai`, `kilo-code-bot`) **MISSED** this.
*Solution:* run `pnpm --filter desktop i18n`, commit the generated catalogs. `<details>` prompt: run the extractor, stage `src/i18n/*/messages*.json`, confirm the 3 strings appear.

🟡 **MINOR — extraction untested.** `createAudioChunkPump` / `createStreamingFinalize` / `helper.hooks` `KEY_ALIASES` have no regression tests guarding the "behavior-preserving" claim (off-by-one in drain, dropped forced-flush). Add unit tests.

🟡 **MINOR — `assert_http_url` (python) is safe** (accepts http+https, rejects file/ftp) but benchmark health-check coupling is fragile; add a test.

🔵 **NITPICK — `HotkeySetting` aria-labels still not localized** (pre-existing).

🔵 **NITPICK — `ToggleRow` flex-start vs center alignment** needs a visual pass; the FeatureReleaseDialog padding regression is **RESOLVED at HEAD** — do not re-open kilo's old comment.

✅ **What is working correctly:** audio-chunking extraction faithful line-for-line (incl. ElevenLabs `isLastChunk` flag); `combineStreamingTranscript` side-effect-free; `createStreamingFinalize` correct; Python `B310` fix correct & safe; `KEY_ALIASES` preserves the `" "` mapping; DRY wins.

---

## 4. Cross-cutting: Top Security Risks (ranked)

| # | Sev | PR | Risk | Required fix |
|---|-----|----|------|--------------|
| 1 | 🔴 | #57 | `run_terminal_command` allow-list includes `cat`; `validate_terminal_command_args` forbids shell metachars but **not** `/` or `..` → `cat /etc/passwd`, `cat ~/.ssh/id_rsa`, `cat ../../secrets` execute. IPC-callable regardless of UI power-mode gate → prompt-injected agent exfil path. | Drop `cat` or canonicalize to an allowed read-root; forbid `/` and `..` in args; consider gating the Rust command on power mode. |
| 2 | 🔴 | #58 | `http:default` wildcard (`https://*` / `http://*:*`) — over-permissive plugin-http egress (least-privilege regression). | Replace `https://*` with curated provider list (or derive from `connect-src`); add TS-side host allowlist. |
| 3 | 🔴 | #59 (pre-existing) | Committed `TAURI_SIGNING_PRIVATE_KEY` literal in 3 CI files (`personal-fork-ci/workflows/build-desktop.yml:109`, `.github/workflows/build-desktop.yml:151`, `release.yml:263`). Not introduced by #59, but #59 is the updater/security surface and should remediate per §5.5. (Public-key half already handled correctly — no committed pubkey literal.) | Move key to a masked secret; remove literals from committed YAML. |
| 4 | 🟡 | #57 | `transcription_import_audio` reads unvalidated path (no canonicalization, §3.2). | Canonicalize + scope the path before use. |
| 5 | 🟡 | #55 | Initial-request URL host not validated (redirect-only policy). | Validate the initial host, not just redirects. |
| 6 | 🟡 | #60 | `assert_http_url` validates scheme only, not host (no SSRF guard). | Acceptable as-is (hardcoded loopback/Apple callers) — note only. |

**Net:** #55 and #60 are security-clean/positive. #57 and #58 **introduce new Critical exposure**. #59 is otherwise §5.5-compliant but **inherits the repo-wide committed-key Critical** (#3).

**Detail — #57 `cat` fix:** the allow-list whitelists the `cat` binary; argument validation blocks `; | & $ ( )` etc. but a path like `/etc/passwd`, `~/.ssh/id_rsa`, or `../../secrets` passes. Because the underlying Rust command is registered and reachable via IPC, this is reachable even when the UI power-mode toggle would otherwise be off. Treat as a prompt-injection exfil primitive for the agent feature and fix before #57 merges.

---

## 5. Cross-cutting: Merge Ordering & Conflicts

**Conflict map**

- **#57 ↔ #60 (HARD CONFLICT, will not auto-merge):** share 11 files. Both rewrite `useHotkeyFire` body in `packages/desktop-utils/src/hotkey.ts` (different extractors: `processFireCombo` vs `evaluateComboRelease`) and both touch `apps/desktop/src/components/root/DictationSideEffects.tsx`.
- **#58 ↔ #59:** both touch `tauri.conf.json` (different sections — likely auto-merge, validate JSON) and `release.yml` (HIGH conflict likelihood in signing/build job).
- **#55 ↔ #57:** both touch `packages/rust_transcription/{Cargo.toml,api.rs,models.rs,onnx_inference.rs}` (`models.rs` artifact_set changes).
- **#57 popout isolation (risky) ∩ #58 `http:default` wildcard:** an isolated-but-IPC-capable popout with `https://*` egress is the worst case — verify the popout renders `ComposerPage` only.
- **#58 `asset:` → `https://asset.localhost` CSP change:** if the asset protocol is `asset://`, this **BREAKS** local avatars/transcription audio in the release bundle (CSP enforced) — verify the scheme.

**Recommended sequence**

```
#55  →  #57  →  #60 (rebase on #57, collapse to a single combo evaluator)
       →  #58  →  #59
```

Rationale: #55 first (cleans `rust_transcription` models/integrity so #57's sidecar changes stack cleanly); #57 before #60 (resolve the shared hotkey/DictationSideEffects conflict once, then rebase #60 onto the merged combo evaluator); #58 next (least-conflict, Ready); #59 last (isolated CI/updater surface; needs the §5.5 key remediation and the manifest/format fixes above).

---

## 6. Unbiased Comparison vs Existing CodeRabbit / Kilo Code Reviews

**Where the independent review AGREES with prior reviews**

- #57: the earlier `..` route-guard bypass finding by `kilo-code-bot` is **correctly resolved** — this review confirms the fix (`validate_local_app_route` rejects literal + `%2e%2e`) and gives credit. No disagreement.
- #58: prior positives on `connect-src` additions, the `remote.urls` loopback isolation, and the `release.yml` token-guard removal are **confirmed** by the contract-test reproduction. No disagreement.
- #59: the "no committed signing key / §5.5 fixed" point was already raised; this review **confirms** it and only adds that the private-key *literal* (separate from the pubkey) is still present and must also be remediated.

**Where the independent review DISAGREES (prior review was wrong/under-stated)**

- **#55 integrity bypass:** a prior reviewer marked the pre-existing-artifact trust gap **"Addressed."** This review asserts it is **NOT addressed** — `download_artifact`/`existing_artifact_set_size` still accept any non-empty file as `Completed` without size/sha256, and `validate_model_classified` does not compare a digest. The "Addressed" status should be reversed.
- **#60 i18n gate:** both `coderabbitai` and `kilo-code-bot` **MISSED** the 3 untranslated strings (MultiDeviceDialog.tsx:309/326, FreeSoloModelAutocomplete.tsx:44) that break non-en locales and the CI i18n gate. This is a concrete miss by the existing reviews.
- **#57 bindings drift:** the existing CodeRabbit review **did not catch** that `transcription_import_audio` + 4 `composer_*` commands are absent from `collect_commands` (orphaned `bindings.ts:853`, desync on next `gen:bindings`). This review adds it.

**Where the independent review goes BEYOND prior reviews (new, not previously raised)**

- #57 **popout SPA duplication** (double `start_recording` via `keys_held` broadcast to `EventTarget::any()`) — entirely new, and the most severe functional blocker.
- #57 **ONNX/SenseVoice runtime** unpinned/unverified silent-failure risk — new.
- #57 **`run_terminal_command` `cat` exfil** (#4 risk #1) — new, security-critical.
- #59 **Windows/Linux-deb updater breakage** (`TargetsNotFound` permanent error; `InvalidUpdaterFormat`) and the `classify()` "setup" substring bug — found independently; prior review focused on signing hygiene, not the manifest/format contract.
- #58 **`http:default` wildcard** least-privilege regression — new framing (prior reviews treated `remote.urls` isolation as sufficient; this review notes the plugin-http egress surface is separately over-broad).
- #55 oversized-chunk-before-cap and pinned-digest-never-validated — new minors.

**Fair summary:** prior `coderabbitai`/`kilo-code-bot` reviews were solid on the security-hygiene and route-guard items but **under-covered (a) the i18n gate, (b) IPC bindings drift, (c) the popout lifecycle duplication, and (d) the auto-updater manifest/format contract.** They also **over-credited** #55's integrity fix.

---

## 7. Prioritized Remediation Plan

Ordered by severity. Tag: `[PR]` + `BLOCKER` (must fix before merge) / `FAST-FOLLOW` (post-merge, tracked).

1. **[#57] BLOCKER** — Isolate Composer popout (no `DictationSideEffects`/`AppSideEffects`/tray) or scope `keys_held` to main window + gate pipeline on `window.label === "main"`. Fixes double transcription/paste.
2. **[#57] BLOCKER** — Add the 5 missing commands (`transcription_import_audio` + 4 `composer_*`) to `collect_commands`, regen `bindings.ts`, route via `commands.*`. Prevents guaranteed future IPC desync.
3. **[#57] BLOCKER** — Remove `cat` from `run_terminal_command` allow-list (or canonicalize to a read-root; forbid `/` and `..` in args; gate on power mode). Closes prompt-injection exfil.
4. **[#57] BLOCKER** — Pin + validate the ORT dylib (version + integrity + clear error + smoke test) before enabling SenseVoice on first use.
5. **[#59] BLOCKER** — Fix updater artifact/manifest contract: emit `windows-x86_64-nsis/-msi` and `linux-x86_64-deb/-rpm` keys; exclude `*.sig` from `classify()`; use `.dmg` for macOS + relax `validate_installer_url`; verify personal-fork-ci YAML anchors parse.
6. **[#55] BLOCKER** — Apply the size+sha256 admission gate to the pre-existing-artifact shortcut paths (`download_artifact`/`existing_artifact_set_size`); reject/redownload unadmitted files. Reverse the prior "Addressed" status.
7. **[#60] BLOCKER** — Run `pnpm --filter desktop i18n` and commit catalogs so the 3 new strings pass the CI i18n gate. (Trivial, but blocks merge + breaks locales.)
8. **[#58] FAST-FOLLOW (pre-release)** — Replace `https://*` wildcard in `http:default` with a curated provider list; widen contract-test `SCAN_ROOTS`; classify plugin-http per call-site.
9. **[#59] FAST-FOLLOW (pre-release, §5.5)** — Remove the committed `TAURI_SIGNING_PRIVATE_KEY` literal from the 3 CI files; keep keys in masked secrets only.
10. **[#57/#55/#60] FAST-FOLLOW** — Add the missing regression/security tests: #60 extraction unit tests (`createAudioChunkPump`/`createStreamingFinalize`/`KEY_ALIASES`); #55 oversized-chunk-before-cap + pinned-digest CI check; #57 hallucination filter language-gating, `agentEnabledTools` null/[] disambiguation, segment-style snapshot-at-start.

---

## 8. Appendix — Methodology

- **Self-review gate (§2.2) applied** to every candidate finding: Cause (in-diff vs pre-existing), Action (compiles/matches idioms), Reaction (call-site/race/CI impact), Necessity (genuine vs style). Pre-existing items (#59 committed key, #60 HotkeySetting aria) are explicitly tagged as such and excluded from "introduced-by" blame.
- **§2.4 ten-point coverage checklist traced per PR:** merge state (§5 conflict map), IPC boundary (#57 bindings drift, #57/#55 path validation), lifecycle (#57 popout side-effects, #55 cleanup paths), persistence (#57 migrations, `agentEnabledTools` migration), UI logic (#60 strings, #57 dead code), UI review (#60 ToggleRow/FeatureReleaseDialog), edge cases (#55 chunk cap, #57 non-Chromium Edit Mode), security (#4 table), test coverage (§7 test items), lint/CI (i18n gate, CI pending notes).
- **Tools used:** `git diff` / `git status` for the per-PR deltas; `rg`/Grep for symbol/string/line citations (`collect_commands`, `http:default`, `classify`, `download_artifact`, i18n strings); GitHub reviews/comments/commits for the existing `coderabbitai`/`kilo-code-bot` baseline (§6); per-PR unit suites (`latest.json` 9/9, contract test mutation check, hallucination-filter tests) for the "working correctly" assertions.
- **Limitations stated:** single-model multi-lens emulation (see Meta); #59 not a live release (simulated manifest builds only); #55/#60 CI pending; #57 cannot exercise new ONNX runtime paths in CI. "VERIFY" items (personal-fork-ci YAML anchors, `asset:` scheme, bundled smoke test) are flagged as such and were not resolved to a binary pass/fail.
