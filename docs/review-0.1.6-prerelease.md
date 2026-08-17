# Pre-Release Audit — `mausVoice-v0.1.5` → `main` (0.1.6)

**Reviewer profile:** CodeRabbit — **Assertive** · Multi-stage agentic pipeline (code-graph + AST/`rg` trace, ensemble cross-check, SAST/lint correlation)
**Base:** `mausVoice-v0.1.5` (`c7efd6f`, pre-release 2026-08-13) · **Head:** `main` (`244d295`)
**Scope:** 53 commits · 489 files · +27,351 / −16,689
**Learnings applied:** `REVIEW.md` §1–§7, plus 172 inline threads across PRs #29–#63 (Kilo Code + CodeRabbit).

---

## Verdict: **Not Ready**

`Confidence: **High**` · `Mergeable: **Yes** (no conflicts)` · `CI Verification: **Pending** (no Rust/Node toolchain in review sandbox; findings are static + trace-derived)`

One **🔴 Critical** regression introduced by this diff silently breaks three shipped transcription providers at runtime. It is a four-line config fix, not an architectural problem — but it is release-blocking, and notably **no existing test or CI gate can catch it**, which is the more important finding.

---

## Walkthrough

This release is dominated by four themes. The dependency chain that matters for the critical finding is drawn below.

**1. Cloud/enterprise excision** (`981d441`, `4b5af51`, `f7f425a`) — removes `packages/functions`, `packages/pricing`, Google/enterprise OAuth, `auth_session.rs`, and the pricing stack. Migrations `071`–`072` rewrite stored `cloud` modes to local/none and drop `is_enterprise`. Clean, transactional, reversible-by-default.

**2. Local ONNX speech models** (#36, #40, #42) — Parakeet CTC/TDT + Canary via real ONNX Runtime (`onnx_inference.rs`, `build.rs`, +1,376 lines in `downloads.rs`) with pause/resume/cancel, generation-keyed jobs, and `If-Range` validator-guarded resume.

**3. Security hardening** — CSP moved from `null` to a strict allowlist; `http:` capability narrowed from `https://*`; `remote.urls` stripped of the docs origin; path canonicalization; least-privilege CI.

**4. Native pill redesign** (#53) — comet ring, shared `advance_ring` policy, `pointer_down` hover pinning across all three platforms.

### Provider request path (the critical trace)

```
SettingsPage ──selects provider──> user_preferences (SQLite)
                                         │
                            getTranscribeAudioRepo(prefs)   apps/desktop/src/repos/index.ts
                                         │
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
     case "groq"                 case "assemblyai"            case "xai" / "aldea"
              │                          │                          │
   packages/voice-ai/groq       voice-ai/assemblyai.utils   voice-ai/xai · aldea.utils
              │                          │                          │
       global fetch()              global fetch()             global fetch()
              │                          │                          │
              ▼                          ▼                          ▼
    ╔═══════════════════════ WEBVIEW CSP connect-src ═══════════════════════╗
    ║  api.groq.com          api.assemblyai.com      api.x.ai              ║
    ║      ✅ ALLOWED             ❌ BLOCKED           ❌ BLOCKED           ║
    ║                          (only *streaming*.     api.aldea.ai         ║
    ║                           assemblyai.com is)      ❌ BLOCKED         ║
    ╚═══════════════════════════════════════════════════════════════════════╝
```

Because these calls use **global `fetch`** (webview-gated by CSP) rather than `@tauri-apps/plugin-http` (gated by `capabilities/default.json`), the `connect-src` directive is the sole enforcement point — and the tightening in this diff never enumerated these three hosts.

---

## Major findings

### 🔴 [Critical — CSP `connect-src` blocks three shipped transcription providers]

`apps/desktop/src-tauri/tauri.conf.json:28`

**The Problem:**

This diff flips `"csp": null` → a strict allowlist (`tauri.conf.json:28`) and simultaneously narrows the `http:` capability from `https://*` → an explicit host list (`capabilities/default.json:61-107`). On `v0.1.5`, `csp: null` meant **no enforcement**, so every provider worked regardless of what the allowlist said. That safety net is gone as of this diff.

Three provider hosts that are reachable in shipped dispatch code were never enumerated:

| Provider | Host | Declared in `API_KEY_PROVIDERS` | Dispatch branch | In `connect-src`? |
| :--- | :--- | :--- | :--- | :--- |
| AssemblyAI (batch) | `https://api.assemblyai.com` | `apiKey.types.ts:8` | `repos/index.ts:328` | ❌ |
| xAI | `https://api.x.ai` | `apiKey.types.ts:20` | `repos/index.ts:387` | ❌ |
| Aldea | `https://api.aldea.ai` | `apiKey.types.ts:7` | `repos/index.ts:331` | ❌ |

The AssemblyAI case is the most deceptive. `connect-src` **does** list `https://streaming.assemblyai.com` and `wss://streaming.assemblyai.com`, so the realtime session in `sessions/assemblyai-transcription-session.ts:206` works fine. But the batch REST path added by **PR #43 in this very range** (`assemblyai.utils.ts:11,35` — upload → create → poll, all on `api.assemblyai.com/v2`) is blocked. A reviewer grepping for "assemblyai" in the CSP finds a match and moves on. The 366-line hardening effort in #43 (retry/backoff, `Retry-After` date parsing, deadline propagation) sits behind a request the webview refuses to issue.

**Failure mode:** the browser rejects the request before it leaves the process. `fetch` rejects with a generic `TypeError: Failed to fetch`, which `assemblyaiTestIntegration` (`assemblyai.utils.ts:16`) swallows into `return false`. The user sees "connection test failed" with a valid API key and no actionable diagnostic. Per REVIEW.md §2.4.7, this is exactly the "platform variation / boundary data" class that only manifests in the packaged build — **`csp` is not applied under `devUrl`, so `pnpm tauri dev` cannot reproduce this.** It ships broken and is green locally.

This is the same class of defect as PR #49 ("restore release-build UI styling (CSP)"), which fixed a `style-src` omission from the same tightening. That was the warning shot; the `connect-src` sweep was never completed.

**The Solution:**

```diff
--- a/apps/desktop/src-tauri/tauri.conf.json
+++ b/apps/desktop/src-tauri/tauri.conf.json
-      "csp": "... https://api.groq.com https://api.cerebras.ai https://api.deepseek.com https://openrouter.ai https://api.elevenlabs.io wss://api.elevenlabs.io https://api.deepgram.com wss://api.deepgram.com https://streaming.assemblyai.com wss://streaming.assemblyai.com ...",
+      "csp": "... https://api.groq.com https://api.cerebras.ai https://api.deepseek.com https://openrouter.ai https://api.elevenlabs.io wss://api.elevenlabs.io https://api.deepgram.com wss://api.deepgram.com https://api.assemblyai.com https://streaming.assemblyai.com wss://streaming.assemblyai.com https://api.x.ai https://api.aldea.ai ...",
```

Add the matching entries to `capabilities/default.json` in the same commit so the two policies cannot drift — `AzureModelProviderRepo` and the OpenAI-compatible paths route through `@tauri-apps/plugin-http` and are capability-gated, so a future refactor from global `fetch` to `tauriFetch` would otherwise re-break these three.

**Verify before merge** (this is the check that should have existed):

```bash
# Every provider host in shipped code must appear in connect-src.
comm -23 \
  <(grep -rhno 'https://api\.[a-z0-9.-]*' packages/voice-ai/src/*.ts apps/desktop/src/sessions/*.ts \
     | sed 's/^[0-9]*://' | sort -u) \
  <(python3 -c "import json,re;c=json.load(open('apps/desktop/src-tauri/tauri.conf.json'));print('\n'.join(sorted(re.search(r'connect-src ([^;]*);',c['app']['security']['csp']).group(1).split())))")
```

Currently emits `api.aldea.ai`, `api.assemblyai.com`, `api.x.ai`. Must emit nothing.

---

### 🟠 [Major — Committed updater signing private key lets anyone forge a trusted auto-update]

`.github/workflows/release.yml:263` · `.github/workflows/build-desktop.yml:151` · `personal-fork-ci/workflows/build-desktop.yml:109`

**The Problem:**

`TAURI_SIGNING_PRIVATE_KEY` is a hardcoded base64 minisign secret key, triplicated across three workflow files. The matching `TAURI_CI_PUBKEY` is stamped into `tauri.conf.json` at build time (`build-desktop.yml:159-161`), and `createUpdaterArtifacts` is `true` (`tauri.conf.json:40`) — so shipped binaries trust this keypair for auto-update.

Anyone who can read this public repository can sign an arbitrary payload that every installed client will accept and silently install. This is REVIEW.md §5.5 verbatim ("never commit signing keys… a fork could sign binaries the app auto-trusts, and never duplicate the literal across CI and setup scripts") and the Anti-Pattern Checklist entry "CI Security · Committed updater keys · Critical".

**Cause gate — honest accounting:** the key predates this diff (present at `v0.1.5:release.yml:194`, introduced around `efa7d72`). Per REVIEW.md §2.2 this is *not* a finding caused by this diff, and I am not counting it against the diff's quality. I am raising it as **release-blocking** because 0.1.6 is the release that turns the updater on for a wider audience, and shipping a signed auto-updater against a publicly-readable private key converts a latent misconfiguration into an active supply-chain distribution channel.

**The Solution:**

1. **Rotate the keypair now** — treat the committed one as permanently compromised; it is in git history and cannot be un-published by deleting the line.
2. Inject `TAURI_SIGNING_PRIVATE_KEY` and the pubkey from repository secrets, referenced once (composite action or reusable workflow) rather than pasted into three files.
3. Set `"createUpdaterArtifacts": false` in the committed config and enable it only in the release job.
4. Add `gitleaks.toml` coverage for `dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWdu` (the minisign secret-key preamble) so a re-commit fails CI. The repo already ships `gitleaks.toml`; this pattern is not in it.

---

### 🟠 [Major — Model artifacts fetched from mutable refs with no digest and an unrestricted redirect policy]

`packages/rust_transcription/src/models.rs:191-215` · `state.rs:25-28` · `downloads.rs:820-829`

**The Problem:**

Three gaps compound in the new ONNX download engine (all introduced by this diff):

1. **Mutable revisions.** Every URL pins `resolve/main` (`models.rs:191-215`). A force-push or account compromise at `onnx-community` / `istupakov` changes what users execute, with no app release. REVIEW.md §7 requires immutable pinning for executable model input.
2. **No integrity verification.** `grep -c 'sha256\|digest' downloads.rs models.rs` → **0**. The only post-download check is `validate_downloaded_size` (`downloads.rs:820-829`), which compares against the server's own advertised `Content-Length` — a value the same server controls. It proves the transfer completed, not that the bytes are the intended bytes.
3. **Default redirect policy.** `reqwest::Client::builder()` at `state.rs:25` sets only `user_agent`, so `reqwest`'s default (follow up to 10 hops, any host) applies. A 302 from an upgraded CDN edge silently retargets a multi-GB download to an arbitrary origin. REVIEW.md §3.3 mandates a custom `redirect::Policy` validating host and scheme.

Combined: the download path will accept and load whatever the endpoint serves, and `.download` temp files are promoted to real artifacts on size match alone.

**The Solution:**

Pin each artifact to an immutable commit SHA (`resolve/<sha>` rather than `resolve/main`) and add an `expected_sha256` field to the artifact tuple in `artifact_set()`. Hash incrementally in the existing streaming loop — the bytes already pass through `downloads.rs:594+`, so this is a `Sha256::update` per chunk and one comparison before the `tokio::fs::rename` at line 667, with no extra I/O pass. Add a `redirect::Policy::custom` to the `state.rs` builder that rejects any hop whose host leaves the allowlist. `sha2` is already in the dependency tree via the workspace lock.

Two Kilo Code threads on #36 (`models.rs:153`, `build.rs:95`) raised (1) and the parallel ORT-cache issue and remain **unresolved**; the ORT `build.rs` path has the same "existence is not integrity" defect at line 81.

---

### 🟠 [Major — `export_transcription` and `get_transcription_audio` still use lexical `starts_with`]

`apps/desktop/src-tauri/src/commands.rs:867` and `:948`

**The Problem:**

`clear_local_data`'s delete path was correctly hardened in this range: `resolve_managed_audio_path` (`commands.rs:449-472`) canonicalizes both the candidate's parent and `audio_dir`, and `delete_listed_audio_files` deletes the returned `PathBuf`, never the raw string. That closes the PR #41 finding properly.

The two **read** paths were not migrated and still use the exact check REVIEW.md §3.2 calls out as insufficient:

```rust
// commands.rs:867  (get_transcription_audio)
if !audio_path_buf.starts_with(&audio_dir) { return Err(...) }

// commands.rs:948  (export_transcription)
if audio_path_buf.starts_with(&audio_dir) && audio_path_buf.exists() { ... }
```

`Path::starts_with` is purely lexical. `<audio_dir>/../../secrets.key` satisfies it, as does `<audio_dir>/link/x` where `link` is a symlink out of the store. Neither side is canonicalized, so an `audio_dir` containing `.`/`..` also fails every legitimate comparison silently.

**Severity qualifier — why Major, not Critical:** `audio_path` is written by the app, not by IPC callers, so reaching this needs prior DB write access. It is a defense-in-depth gap and a **comment/code drift bug** of exactly the kind Kilo Code flags: `commands.rs:1353` documents the canonicalizing guard as the module's contract, and a reader will reasonably assume it applies to all three audio paths. It does not.

The asymmetry is also self-evidently unintended — the same PR fixed one of three call sites of the same pattern.

**The Solution:**

Route both through the existing validated helper. It already returns the canonical path, and the "file may not exist yet" concern does not apply to read paths:

```diff
-    if !audio_path_buf.starts_with(&audio_dir) {
-        return Err("Audio snapshot path is outside the managed directory".to_string());
-    }
+    let audio_path_buf = resolve_managed_audio_path(&audio_path_buf, &audio_dir)
+        .ok_or_else(|| "Audio snapshot path is outside the managed directory".to_string())?;
```

and at `:948`:

```diff
-            if audio_path_buf.starts_with(&audio_dir) && audio_path_buf.exists() {
+            if let Some(audio_path_buf) = resolve_managed_audio_path(&audio_path_buf, &audio_dir)
+                .filter(|p| p.exists())
+            {
```

`resolve_managed_audio_path` is a free function in the same module, already unit-tested at `commands.rs:2964-3005` including the symlinked-subdirectory case. No new test scaffolding needed — extend that test with the two read paths.

---

## Minor findings

### 🟡 [Minor — Two workflows carry no `permissions:` block]

`.github/workflows/build-desktop.yml` · `.github/workflows/lint-desktop.yml`

*Context:* `release.yml`, `test-desktop-unit.yml`, `test-docs.yml`, and `test-package-rust-transcription.yml` all declare `permissions: contents: read` on verification jobs — that hardening landed in this range (`244d295`). These two were missed, so they inherit the repository default, which is `write-all` unless the org has changed it. Both check out code and execute `pnpm`/`cargo` against PR-authored input. Add `permissions: { contents: read }` at workflow level. REVIEW.md §5.2.

### 🟡 [Minor — Native pill `cargo test` runs on Windows only]

`.github/workflows/lint-desktop.yml:103-107`

*Context:* All three pill crates get `cargo clippy --all-targets` (lines 95–101), but only `rust_windows_pill` and `rust_pill_shared` get `cargo test`. `rust_macos_pill/src/draw.rs`, `rust_gtk_pill/src/draw.rs`, `rust_gtk_pill/src/input.rs`, and `rust_gtk_pill/src/pill.rs` all contain `#[test]` blocks that never execute in CI. This is materially risky *for this release specifically*: PR #53 rewrote the ring renderer and hover state machine across all three platforms, and the `RingAnim::default` sentinel bug (zeroed `arm_pulse` reading as "pulse running") was caught **only** because `rust_pill_shared` happens to be tested on Linux. The macOS and GTK equivalents of that class of bug have no gate. Add the two missing `cargo test` steps under the existing `macos-14` / `ubuntu-22.04` matrix legs. REVIEW.md §5.6.

### 🟡 [Minor — `build-desktop.yml` PR trigger omits paths that affect compilation]

`.github/workflows/build-desktop.yml:19-26`

*Context:* The `push` filter correctly lists `packages/**`, `patches/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`. The `pull_request` filter lists only `apps/desktop/**`, `apps/windows-installer/**`, and the workflow file. A PR touching `packages/rust_transcription` or `pnpm-lock.yaml` — i.e. most of this release — does not trigger a desktop build, and the break surfaces only after merge to `main`. Mirror the `push` list. REVIEW.md §5.3.

---

## Nitpick findings

- **`utils/sync.rs:14`** — `lock()` recovers from poison by design and the rationale is well documented, but `#[must_use]` on the returned guard would prevent a caller from accidentally discarding it and releasing immediately. Trivial.
- **`capabilities/default.json:61-107`** — the `http:` allowlist still carries the full Firebase/Google origin set (`*.firebaseio.com`, `*.firebasestorage.app`, `accounts.google.com`, `identitytoolkit.googleapis.com`) after `981d441` deleted the entire cloud/auth stack. Dead grants widen the capability surface for no consumer; `grep -rn firebase apps/desktop/src` returns no request site. Same stale set is mirrored in `connect-src`.
- **`commands.rs:2581-2585`** — the comment explaining that `maus-inc.github.io` loads without IPC is accurate and matches the `remote.urls` removal. Good example of the comment/code parity REVIEW.md §1.2 asks for; noting it so a future cleanup does not "simplify" it away.

---

## UI review findings

- **No `transition: all` anywhere** in `apps/desktop/src` — all transitions are property-scoped (e.g. `ElasticSlider.tsx:112` `transition: "height 160ms cubic-bezier(0.23, 1, 0.32, 1)"`). Meets REVIEW.md §2.4.6.
- **`ElasticSlider.tsx:60-79`** — correctly honors `useReducedMotion()` by swapping the motion wrapper for a plain `div` rather than merely zeroing the duration, and the drag/commit split (`draggingRef` + `onChangeCommitted`) is the right fix for thumb lag. The `useEffect` at `:67` guards external updates against in-flight drags. No findings.
- **Theme continuity** — `f64d6788` fixes light mode overriding system theme, and `index.html` now assigns the legacy mode *before* the best-effort `setItem` so a storage failure retains the valid preference rather than falling back to `system`. Regression test present in `theme.test.ts`. No un-themed flash path found.
- **Startup error overlay** (`installGlobalErrorOverlay`, capture-phase DOM listener registered before generated tags) is a genuine improvement — it converts the "blank window on asset load failure" class into a visible, URL-bearing message. Worth noting it will **not** surface the critical CSP finding above, since a blocked `fetch` is a rejected promise, not a resource load error.

---

## Missing important test coverage

1. **No CSP/provider-host parity test.** *This is the gap that let the critical finding through.* Every provider is unit-tested at the util level with a mocked `fetch`, which by construction never consults the CSP. Add a Node test that parses `tauri.conf.json`'s `connect-src` and asserts every `https://` literal in `packages/voice-ai/src/*.ts` and `apps/desktop/src/sessions/*.ts` is covered — the one-liner in the critical finding is the whole test. It is cheap, it is dynamic (not tautological per REVIEW.md §1.2), and it fails today.
2. **`get_transcription_audio` / `export_transcription` path validation is untested.** `resolve_managed_audio_path` has good coverage (`commands.rs:2964`, incl. symlinked subdirectory); the two read call sites have none, which is why they were missed during the delete-path hardening.
3. **ONNX E2E tests are inert.** `sidecar_integration.rs` gates the new ONNX tests behind `MAUSVOICE_RUN_ONNX_E2E`, which no workflow sets — each returns `Ok(())` without downloading or running inference. When enabled, `!response.text.trim().is_empty()` would still accept arbitrary output and would not have detected the fabricated-transcript bug #40 fixed. Assert normalized output against the known `test.wav` transcript. (Open CodeRabbit thread on #36, `sidecar_integration.rs:730`.)
4. **No redirect/digest test for the download engine.** The new test server harness in `downloads.rs:1144+` already fakes HTTP responses; adding a 302-to-foreign-host case and a corrupted-bytes case is incremental work on existing scaffolding.

---

## What is working correctly

Credit where the hardening landed — several of these are direct, verified closures of prior review findings:

- **Tautological privacy test replaced with a real one.** `user_data_tables_to_clear_covers_the_privacy_set` (`commands.rs:2934`) now replays the migration SQL through a hand-written tokenizer (`strip_sql_noise`, handling block/line comments, `''` escapes, and quoted identifiers), reconstructs the live table set including `DROP`/`RENAME`, and asserts bidirectional coverage against `USER_DATA_TABLES_TO_CLEAR` with an explicit empty `NON_USER_DATA_TABLES` allow-list. This is exactly the dynamic-extraction pattern REVIEW.md §3.5 demands, and it is better than the handbook's own suggestion — it derives from migrations rather than a live `sqlite_master`, so it needs no database fixture. Closes the PR #41 finding fully.
- **`clear_local_data` is transactional.** `pool.begin()` at `:1341`, all deletes on `&mut *transaction`, single `commit()` at `:1349`, disk deletion strictly after commit. No partial-wipe window.
- **Model cache contention resolved correctly.** `onnx_inference.rs:53-62` acquires the global `MODEL_CACHE` lock only to clone the per-model `Arc<Mutex<_>>`, releases it via scope exit, then loads and runs inference under the per-model lock. Different models now load and transcribe concurrently. Exactly REVIEW.md §3.8, and the inline comment states the invariant accurately.
- **`cancel_typing` scoped to a live session.** `commands.rs:1794` early-returns unless `SIMULATE_TYPE_IN_PROGRESS` is set, so a late cancel cannot abort a subsequent session — and the test at `:2774` reads the prior value and restores it at `:2791`, so it no longer poisons parallel tests. Both halves of the PR #41 finding closed.
- **Download resume is validator-guarded.** `request_artifact_response` (`downloads.rs:831-841`) refuses to append without an `If-Range` validator tied to the existing prefix, and `begin_artifact_finalization` (`:675`) is generation- *and* `is_finalizing`-checked with cancel-only cleanup — the "pause during finalization discards a completed artifact" race from #36 is genuinely fixed, not papered over.
- **`useAsyncData` render-purity fixed properly.** `async.hooks.ts:110-127` passes `timeoutMs` per call (`controller.run(promise, timeoutMs)`) rather than freezing it at construction, holds `useState` setters directly instead of a sink ref, and the comment at `:120` now describes what the code actually does. Both the render-phase-write and stale-config findings closed, and the doc drift with them.
- **`vitest` override floor retained.** `"vitest@<3.2.6": ">=3.2.6 <4.0.0"` keeps both bounds, so the upper cap did not silently permit a downgrade into the vulnerable range. REVIEW.md §5.4 satisfied.
- **`turbo.json:22`** — `"check-types": { "dependsOn": ["^build"] }`. The tautological `^check-types` dependency is gone. REVIEW.md §5.1.
- **Windows elevation error handling.** `init.rs` replaces both `current_exe().unwrap_or_default()` calls with explicit matches that log and return `Failed` / `exit(1)` — an empty `PathBuf` would previously have been passed to `ShellExecuteW`. UAC cancellation is now logged and returns `Cancelled` rather than being conflated with failure.
- **`remote.urls` restricted to loopback.** The `https://maus-inc.github.io/mausVoice/*` entry is removed, so the docs webview loads without native command access, and `validate_floating_window_url` (`commands.rs:2574`) enforces scheme *and* host with a path prefix check. Unit-tested at `:2739-2745`, including the `other-project` near-miss.

---

## Fix order

| # | Finding | Effort | Blocking |
| :--- | :--- | :--- | :--- |
| 1 | CSP: add `api.assemblyai.com`, `api.x.ai`, `api.aldea.ai` (+ capability parity) | ~4 lines | **Yes** |
| 2 | Add the CSP/provider parity test | ~15 lines | **Yes** — prevents recurrence |
| 3 | Rotate updater key; inject from secrets; gitleaks rule | ~1 hour | **Yes** for a signed release |
| 4 | `resolve_managed_audio_path` at `commands.rs:867` / `:948` | ~8 lines | Recommended |
| 5 | `permissions: contents: read` on the two workflows | ~4 lines | Recommended |
| 6 | Digest + immutable pins + redirect policy for model artifacts | ~half day | Next release acceptable |
| 7 | `cargo test` for macOS/GTK pills; PR path filters | ~6 lines | Next release acceptable |

Items 1–2 are the merge gate. With them applied I would move this to **Ready**, `Confidence: High`, pending a green CI run.
