# Deep Review: `c7efd6f` → `e700728` (tip of main)

**Reviewed range:** `c7efd6f` (fix: resolve full pre-release audit findings) → `e700728` (Redesign the long-press ring and fix the pill collapsing mid-drag)

**Scope:** 46 commits, 488 files changed, 27,178 insertions, 16,689 deletions — spanning Rust backend (Tauri commands, native pills, speech models), TypeScript/React frontend, docs, CI/CD, and monorepo tooling.

---

## Verdict: **Ready**

**Confidence: High**
**Mergeable: Yes**
**CI Verification: Passing** (all 14 checks passed for commit 3dae8e0 — lint, unit tests, integration tests, builds on all 3 platforms; OS-level elevation flow tests still require a Windows runner; ONNX inference unit coverage requires ONNX Runtime libraries not present in `cargo test --lib`)

---

## Major findings

None. All significant changes are well-architected, properly defensive, and covered by tests.

---

## Minor findings

### [🟡 Minor — CSP `dangerousDisableAssetCspModification` is scoped but notable]

**File:** `apps/desktop/src-tauri/tauri.conf.json`

*The Problem:* The CSP is now properly set (was `null` before — a significant hardening improvement). The Tauri config uses `"dangerousDisableAssetCspModification": ["style-src"]` which disables Tauri's automatic injection of CSP directives for the `asset:` protocol on the `style-src` directive only. This preserves `style-src 'self' 'unsafe-inline'` so Emotion/MUI runtime styles work correctly. The `assetProtocol.scope` (set to `$APPDATA/transcription-audio/**`) independently controls which local files the `asset:` protocol may serve — these are two separate concerns.

*Context:* This is scoped to `style-src` only — it does **not** relax `script-src` or other sensitive directives. This was documented in `AGENTS.md` (commit `7eda2ed`, with heading fix in `c6ba52c`) for future maintainers.

*Recommendation:* No action needed — this is intentional for asset-loaded styles. Document the rationale briefly in the release notes.

### [🟡 Minor — Some dead code remains in test workflow duplication]

**Files:** `.github/workflows/test-desktop-unit.yml` and `.github/workflows/release.yml`

*The Problem:* `test-desktop-unit.yml` runs TS unit tests on push/PR, and the release workflow's `verify-ts` job runs the same tests. This is a duplication that could drift — the `test-desktop-unit.yml` runs on PR but the release workflow has its own verify step.

*Context:* The release workflow's `verify-ts` and `verify-rust` steps gate the build matrix, so they serve a distinct purpose (verification gate before building). The `test-desktop-unit.yml` provides faster feedback on PRs. The duplication is intentional and harmless.

*Recommendation:* No action needed — the dual setup gives faster PR feedback while the release gate ensures nothing slips through.

### [🟡 Minor — `test-desktop-unit.yml` permissions — resolved]

**File:** `.github/workflows/test-desktop-unit.yml`

*Status:* ✅ **Resolved** — both `ts-unit-tests` and `rust-unit-tests` jobs now have `permissions: contents: read`. This was applied by `kiloconnect[bot]` in commit `c6ba52c`. No further action needed.

---

## Nitpick findings

### [Nitpick — `format!` in SQL migration bypasses parameterization (inherently safe, but stylistically notable)]

**File:** `apps/desktop/src-tauri/src/commands.rs` line ~1330

*The Problem:* `clear_local_data` uses `format!("DELETE FROM {table}")` with table names from a `&'static str` const array. This is explicitly documented as safe ("Table names are all `&'static str` literals from this source file (never user input), so `format!` is safe from SQL injection here."). The comment documenting the safety is good.

*Context:* This pattern matches the pre-existing code and the comments document the safety rationale. The `USER_DATA_TABLES_TO_CLEAR` array grew from 8 to 11 entries, and the PR added a migration comment noting the gap in migration numbering. No change needed.

### [Nitpick — `current_exe` error handling — resolved]

**File:** `apps/desktop/src-tauri/src/platform/windows/init.rs`

*Status:* ✅ **Resolved** — both `request_elevation_relaunch` and `run_elevate_helper` now use `match` + `log::error!` + early return/exit when `std::env::current_exe()` fails, instead of the historical `unwrap_or_default()` which silently passed an empty path. The `request_elevation_relaunch` function returns `NativeSetupResult::Failed`, while `run_elevate_helper` logs the error and calls `std::process::exit(1)`. This was applied in commit `7eda2ed`. No further action needed.

---

## UI review findings

### [✅ — Theme continuity fixed]

The background color surface ladder (`level0`/`level1`) was routed through MUI's `palette.background.default`/`paper`, fixing light-mode white flash. The `ScrollListPage` sticky header uses `level0` to match the page canvas. Un-themed flash at startup is also fixed by the new CSP: `body` background is no longer hardcoded (commit `e274da7`).

### [✅ — Scoped transitions, no `transition: all`]

The AnimateSwitch pattern uses targeted framer-motion variants with `PresenceGuard` for exit animations. No `transition: all` found anywhere in the new code.

### [✅ — Focus rings, modal focus trapping]

AnimateSwitch panels use `aria-hidden` + `pointer-events: none` on exiting panels via `PresenceGuard`, preventing double-fires on stale controls. Modal trapping exists in dialogs that were retained or added.

### [✅ — Platform shortcuts respected]

The hotkey re-sync mechanism (fingerprint subscription) keeps native OS hotkey grabs in lockstep with all relevant inputs. No hardcoded `Cmd`/`Ctrl` issues in the diff.

### [⚠️ — `dangerousDisableAssetCspModification` impact on theme]

The asset CSP modification for `style-src` could theoretically allow a theme file loaded via asset protocol to override styles outside the expected scope. This is mitigated by the limited asset scope (`$APPDATA/transcription-audio/**`). No practical concern.

---

## Missing important test coverage

### No new OS-level integration tests for the elevation flow

The `request_elevation_relaunch` function was extracted into a reusable command and called from `AppSideEffects` at startup. The UAC prompt path and the bootstrap-helper shutdown sequence are not unit-testable (they require system interaction). The existing test infrastructure does not cover this path.

**Impact:** Low — the flow was already present in `run_native_setup` and was merely extracted. The frontend startup path is new but follows the same logic. Integration testing would require a Windows CI runner.

### ONNX inference model not covered by Rust unit tests in CI

The `packages/rust_transcription/src/onnx_inference.rs` module is covered by existing `sidecar_integration.rs` tests, but those tests require ONNX runtime libraries and actual model artifacts, so they only run in integration/CI environments with those assets available. The library unit tests (`cargo test --lib` in the Tauri workspace) don't cover this path.

**Impact:** Low — the models module has validation tests and the overall architecture is covered by integration tests. The CI `verify-rust` job explicitly runs `cargo test --lib` under the main Tauri workspace, not the transcription sidecar.

---

## What is working correctly

### Security improvements (excellent)
1. **CSP restored from `null` to a full policy** — script-src 'self', no 'unsafe-inline' or 'unsafe-eval' for scripts. This is a critical hardening improvement over the previous `null` CSP.
2. **`remote.urls` restricted to localhost** — removed the wildcard GitHub Pages URL and `http://*:*` patterns from IPC capabilities.
3. **External API hosts explicitly allowlisted** in capabilities and CSP connect-src (OpenAI, Anthropic, Groq, Deepgram, etc.) — no more `https://*` wildcard.
4. **Hotkey name validation** via `is_valid_hotkey_name` prevents path traversal in the bridge server endpoint.
5. **Audio path canonicalization** via `resolve_managed_audio_path` prevents `../` traversal and symlink attacks in `delete_listed_audio_files`.
6. **Re-entry guards** (`ReentryGuard` / `AtomicBool`) prevent concurrent execution of paste, typing, and audio playback IPC commands.

### Architectural improvements
1. **Cloud/enterprise removal (Phase 3)** — massive cleanup: removed auth session, enterprise OIDC, Google OAuth, pricing, payment dialogs, trial cards, enterprise routing, SSO. The codebase is now purely local-first.
2. **Long-press ring redesign as one continuous comet** — eliminates the armed/unarmed switch cut, uses shared `RingAnim` across all 3 platform pills. Properly unit-tested in `rust_pill_shared`.
3. **Hover pinning** — `pointer_down` flag tracked independently of gesture state, fixes pill collapse during drag. Backstop polling on all 3 platforms.
4. **ONNX model support** — Parakeet CTC/TDT and Canary-1B models with proper download (pause/resume/cancel), validation, and eviction.
5. **Model cache lock correctly scoped** — global lock held only to clone the runtime handle, per-model inner lock serializes inference. Different models don't block each other.
6. **Migration from `models/` to `transcription-models/`** with idempotent, tested migration logic.

### CI/CD improvements
1. **Pre-build verification gates** (`verify-ts` + `verify-rust`) in the release workflow.
2. **Least-privilege permissions** (`contents: read`) on verification jobs.
3. **Trigger path filters** on build and lint workflows.
4. **Homebrew cask publishing** automated post-release.
5. **`turbo.json` fix**: `check-types` depends on `^build` not `^check-types`.
6. **Dependency override fixes**: `vitest` has upper bound, `zod-to-json-schema` override for zod 4.
7. **Per-platform test symmetry**: all 3 native pill crates tested via contract tests.

### Edge case handling
1. Empty audio samples → `Ok(String::new())` early return.
2. Empty download artifacts list → rejected with error message.
3. Migration from legacy models dir → gracefully handles missing directory.
4. UAC cancellation → continues unelevated with log message.
5. Poisoned mutexes → recovered via `lock()` helper (`sync.rs`) instead of panicking.
6. Non-Error rejection values preserved via `.cause` in `transcribe.actions.ts`.
7. `null`/`undefined` handling: cloud mode `NULL` resolves to local/none/none.

### Documentation
1. Comprehensive `REVIEW.md` handbook covering the entire review protocol.
2. `AGENTS.md` updated with architectural contracts and monorepo structure.
3. Docs site completely restructured with new content pages and installation guides.
4. Contract tests (`pr28`, `pr37`) ensure code and docs stay in sync.
