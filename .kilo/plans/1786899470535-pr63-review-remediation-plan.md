# Plan: Remediate EVERY review finding on PR #63 (`fix/superfix-review-findings`)

**Source audit:** Assertive CodeRabbit-profile review of PR #63 (integrates #55 → #57 → #60 → #58 → #59), run as 6 subagents / 3 waves (backend/Rust/CI, frontend/TS, Security/SAST, Architecture/merge-integrity, Synthesis, Gap/verification). Full report: `UNIFIED_REVIEW.md` (review scratch dir). This plan turns **every** pointed-out item into an actionable task.

**Severity key:** 🔴 Critical · 🟠 Major · 🟡 Minor · 🔵 Nitpick · 🧹 cleanup.

**Goal:** Make PR #63 safely mergeable by resolving all 🔴/🟠 blockers plus the 🟡/🔵 items, removing stray artifacts, and restoring `REVIEW.md`. Do **not** merge on the strength of the prior `kilo-code-bot` "No Issues Found" verdict — this audit contradicts it.

**Environment caveat (important):** This planning session cannot run `cargo`, `tsc`, `pnpm gen:bindings`, `pnpm i18n`, or `prettier` (no linker / sandbox limits). Every task below lists a **validation** step; the final authority is CI (clippy, oxlint, prettier, `pnpm gen:bindings`, typecheck, and the new i18n gate). Confirm each fix locally where possible, but treat CI green as the merge gate.

---

## A. Pre-merge BLOCKERS (🔴 + 🟠) — must land before merge

### C1 — 🔴 SenseVoice ONNX graph is unpinned/unverified (supply-chain RCE)
- **Where:** `packages/rust_transcription/src/models.rs:142` (mutable `resolve/main/` URL), `:144` (`sha256: None`), `:257-276` (the `!= SenseVoice` carve-out in `onnx_primary_is_first_in_artifact_set`); loaded in-process via ONNX Runtime at `onnx_inference.rs:399-411`.
- **Why it's Critical:** the only newly-added ONNX model is fetched from a **mutable** URL with **no digest**, then executed in-process → unauthenticated remote code execution. The PR's own thesis is model integrity, yet the `159321b47` commit ("exempt SenseVoice from resolve/main test assert") *silently disabled* the gate.
- **Action:** pin `model.int8.onnx` (+ `tokens.txt`) to an immutable `resolve/<40-hex-commit>/` URL with the upstream LFS SHA-256; make `artifact_set()` return `Some(digest)` for SenseVoice; **delete the `!= SenseVoice` / `WhisperModel::SenseVoice` carve-out** in the test. Add a positive test asserting SenseVoice carries a digest + immutable revision.
- **Validation:** `cargo test -p rust_transcription` passes with the carve-out removed; `models.rs` shows no `resolve/main/` for SenseVoice and a `Some(...)`.

### C2 — 🔴 i18n catalog never regenerated (~54 missing ids)
- **Where:** `apps/desktop/src/i18n/locales/en.json` (+ 9 locale files). New `createMessageId(...)` strings (composer, style hotkeys, tones category/outputLength/exampleInputOutput, SenseVoice, agent max-iterations/timeout, import audio, review-before-insert, updater) were hand-added but `pnpm i18n` was never run (AGENTS.md mandate). Verified by running the repo's own extractor, not key-count.
- **Action:** run `pnpm --filter desktop i18n` (or `pnpm i18n`) at the integration head; commit the regenerated `en.json` + the 9 synced locales. Add a CI step that fails if `en.json` drifts from extraction.
- **Validation:** `pnpm i18n` is a no-op after commit (catalog matches extractor); all ~54 ids present in `en.json`.

### M1 — 🟠 `allowedAdditionalKeys` hold-to-talk silently dropped (merge-integrity regression)
- **Where:** `packages/desktop-utils/src/hotkey.ts` (PR #60 rewrote the evaluator to a 2-arg `matchesCombo` + `useHotkeyHoldMany`, dropping the field) vs caller `apps/desktop/src/components/root/DictationSideEffects.tsx:1011-1024` (PR #57 still passes `allowedAdditionalKeys` + a comment claiming style-switch arrows are tolerated). Because `genericActions` is built as a **variable**, `tsc` does **not** raise an excess-property error → the prop is silently ignored; holding `DICTATE` + any extra key fails the exact `uniqueHeld.length === required.length` match.
- **Action (preferred):** re-add `allowedAdditionalKeys?: string[]` to `HoldAction` / `UseHotkeyHoldManyArgs` and apply it inside `useHotkeyHoldMany`'s match (tolerate the listed extra keys). **Or:** remove the dead arg + the now-misleading comment in `DictationSideEffects.tsx:1011-1024`.
- **Validation:** hold-to-talk activates with style-switch arrows held; a unit/integration test asserts the tolerance; `tsc` + existing hotkey tests green.

### M2 — 🟠 "Review before insert" opens a composer popout on every realtime interim token
- **Where:** `apps/desktop/src/utils/output-routing.utils.ts:88-92` → `apps/desktop/src/strategies/dictation.strategy.ts:77` (`handleInterimSegment`). With realtime verbatim + review enabled, each streamed token spawns a blocking `floating_window_create` composer (up to `COMPOSER_TIMEOUT_MS` = 5 min).
- **Action:** add a `skipReview` flag to `routeTranscriptOutput`; interim segments take an insert-only path; only the **finalized** transcript enters the composer.
- **Validation:** realtime dictation with review-before-insert enabled no longer spawns popouts on interim tokens (manual + a unit test on `routeTranscriptOutput`).

### M3 — 🟠 Import-audio dialog Style/Language selection resets every render
- **Where:** `apps/desktop/src/components/transcriptions/TranscriptionsPage.tsx:46-50,58-64`. `tones` selector returns a new array each render; seed `useEffect` deps include `tones` and run `setSelectedToneId(tones[0]?.id ?? null)` each time → selection can never hold a non-default value; `importAudioFile` always imports with defaults.
- **Action:** drop `tones` from the seed effect deps; seed once on the open-transition using the existing `prevImportDialogOpen` ref.
- **Validation:** user's Style/Language choice persists across renders and is used by `importAudioFile`; contradicts the prior bot "resolved" claim — verify against current code.

### M4 — 🟠 8 new strings left as English copies in all 9 non-English locales
- **Where:** `locales/{es,fr,de,pt,pt-BR,it,zh-TW,zh-CN,ko}.json` for keys `delete_hotkey`, `device_platform`, `device_role`, `disable_hotkey`, `revert_to_default_hotkey`, `select_or_type_a_model`, `version_version`, `voice_editing_is_not_supported_on_this_platform`.
- **Action:** provide real translations (or, at minimum, ensure `pnpm i18n` tracks them). AGENTS.md violation.
- **Validation:** keys present + translated in all 9 non-English locales.

### M5 — 🟠 New commands absent from capability permissions (runtime-verify)
- **Where:** `apps/desktop/src-tauri/capabilities/default.json` vs `app.rs:334,406-408` / `bindings.ts`. `composer_register_text`, `composer_peek_text`, `composer_discard_text`, `transcription_import_audio` are registered + exposed but have no `desktop:allow-*` grant. Mirrors the pre-existing pattern (all custom commands absent), so either non-issue or silent runtime failure.
- **Action:** runtime-verify all four are invocable from `main` + `floating-*` windows; add explicit `desktop:allow-*` grants if the build does not implicitly permit them; document the implicit-allow pattern so future `default.json` tightening doesn't silently break composer/import.
- **Validation:** composer text round-trip + audio import work from both window types in a packaged/dev build.

---

## B. Minor fixes (🟡) — ride along with the blocker fixes

- **MN1 — `processFireCombo` divergent/incorrect duplicate evaluator.** `packages/desktop-utils/src/hotkey.ts:332-403`. Exported combo evaluator stores `state.previousExact = currentExact` (semantically wrong, never read by its own logic) while the live `useHotkeyFire` uses `evaluateComboRelease`/`updateComboState`. → Delete `processFireCombo` or route both through one function. *Validate:* hotkey tests pass; no dead duplicate.
- **MN2 — TOCTOU in `transcription_import_audio` confinement.** `apps/desktop/src-tauri/src/commands.rs:453-484` canonicalizes/validates `starts_with` then reopens. → Open the already-canonical handle and re-verify. (The arbitrary-file-read oracle itself is resolved by the user-dir allow-list.) *Validate:* import confined to allowed roots.
- **MN3 — Unstable `useAppStore` selectors return fresh arrays.** `DictationSideEffects.tsx:169-170`, `TranscriptionsPage.tsx:46`. → `useShallow`/memoize. *Validate:* no per-store-change re-render storms.
- **MN4 — Hallucination filter applied three times.** `transcribe.actions.ts:173`, `dictation.strategy.ts:101`, sidecar/ONNX silence gate. → Confine to one (TS final) layer. *Validate:* behavior unchanged (idempotent today).
- **MN5 — `audio-chunking` aliases caller buffer.** abc `audio-chunking.utils.ts:145-148` + `drainSamples` `pendingChunks[0] = current.subarray(remaining)`. → Clone on push or document ownership contract. *Validate:* no cross-call buffer corruption.
- **MN6 — Style-hotkey conflict check over-broad.** `StyleHotkeysDialog.tsx:43-58` flags subset/superset combos. → Tighten to exact-overlap. *Validate:* legitimate distinct combos not flagged.
- **MN8 — `IMPORT_IN_FLIGHT` Drop guard (disputed).** `commands.rs:520/594`. Prior bot claims resolved via `ImportInFlightGuard`; integration wave still lists the guard as required. → Verify at HEAD whether the `Drop` is present and held across the `spawn_blocking` `.await`; if absent, add the `Drop` guard so the in-flight flag resets on every exit path (permanent import-DoS otherwise). *Validate:* dropping the command future resets the flag (test or manual).
- **MN9 — ggml `.bin` whisper models still mutable `resolve/main/`, no digest.** `models.rs:188-213` / `api.rs`. Pre-existing, outside this PR's ONNX scope → **post-merge follow-up** (track, not a blocker).
- **MN10 — `http:default` widened to `http://*:*` / `http://*:*/**`.** `capabilities/default.json`. Documented tradeoff for user-configured base URLs; plugin-http runs in Rust and is not bounded by strict CSP `connect-src`. → Record in the threat model as a least-privilege residual (acceptable by design). *Validate:* threat-model note added.
- **MN11 — `buildMixpanelProfile` extraction correctness.** `AppSideEffects.tsx` → `analytics.utils.ts` (PR #60 extract). Symbols present; QA that Mixpanel identity + `dayjs().diff(onboardedAt,"day")` still posts. *Validate:* analytics event shape unchanged.

---

## C. Nitpicks (🔵) — fast-follows

- **NP1 — `.` segment accepted by `validate_local_app_route`.** `commands.rs:2823-2850`. Harmless (Tauri resolves `./composer`→`composer`); clarity nit. → Reject/strip `.` segments explicitly.
- **NP2 — `shared_audio` via `#[path]` macro.** `commands.rs:72-73`. Acceptable DRY reuse of the sidecar resampler; document intent.
- **NP3 — DRY duplicate value helpers.** `preferences.repo.ts:~199-215` (`nullableValue`/`booleanValue`/`valueOr` duplicate `orNull`/`orFalse`/`orValue`). → Remove locals, reuse shared helpers.
- **NP4 — `console.log` in production streaming paths.** `streaming-session.utils.ts:48-98`, `composer.utils.ts`. → Use `getLogger()`.
- **NP5 — 5 orphan `en.json` keys.** Pruned automatically by running `pnpm i18n` (tied to C2). *Validate:* no orphan keys after regeneration.
- **NP6 — `.ghtoken` credential still in git history.** `.gitignore:114` ignores it going forward, but the previously committed token (`kgh2…`) remains recoverable from history/forks. → Rotate/revoke now; purge via `git filter-repo`/`bfg` + force-push (out-of-diff; schedule, not a #63 blocker).

---

## D. Remove stray artifacts (🧹) — must not be merged

The PR diff accidentally carries review-process byproducts:
- Delete `UNIFIED_REVIEW.md` (added, 189 lines).
- Delete `pr_body.md` (added, 29 lines).
- Delete `.review-pr59` (added, 1 line).
- **Restore `REVIEW.md`** to its canonical handbook form — the PR currently modifies it `+5 / -542`. (Note from verification: `main` had the handbook duplicated ~5×; the PR head is a clean single copy, so "restoring" = keeping the clean single copy and **not** carrying the condensed diff — confirm the file matches the intended canonical handbook, not the pre-duplication state.)

---

## E. Merge-integrity reconciliation notes (from Wave 2/3)

- **M1 is the one genuine functional regression** of the integration: PR #60's `hotkey.ts` rewrite (landed after #57) dropped `allowedAdditionalKeys` while the #57 caller was not updated. Everything else reconciled correctly; #58/#59 were *strengthened* beyond their branch tips.
- **i18n gap (C2/M4):** `pnpm i18n` was never run at the integration head; `c2cd875c2` only patched the PR #60 subset. Fix = full regeneration (C2), not another partial patch.
- **SenseVoice carve-out (C1)** was introduced *inside* #63 by `85747f8ad` (make crate compile) + `159321b47` (exempt from the assert) — a self-inflicted gate-bypass to be reverted.
- **Verified working (do not re-litigate):** composer popout isolation (`emit_to("main", EVT_KEYS_HELD)` + `!isMainWindow` guard, no double-fire); bounded composer text store; `bindings.ts` regenerated and in sync with `gen_bindings.rs`/`app.rs`; migrations 075/076 counts align; capabilities hardened (curated https, `remote.urls` loopback); committed signing keys removed (secrets only); updater manifest requires `.sig`; terminal allow-list hardened (`cat` removed, `/`,`\`,`..` forbidden); import arbitrary-file-read oracle closed via user-dir allow-list; no `dangerouslySetInnerHTML`/`eval`.

---

## F. Ordered execution sequence (dependencies)

1. **C1** (pin SenseVoice + delete carve-out) — independent; do first (security).
2. **C2 + M4** (regenerate i18n + translate 8 keys) — run `pnpm i18n` once all feature strings are final.
3. **M1** (restore `allowedAdditionalKeys` OR remove dead arg) — independent of i18n.
4. **M2** (review-before-insert `skipReview`) — independent.
5. **M3** (import-dialog selection reset) — independent.
6. **M5** (verify new-command capabilities; add grants if needed) — independent.
7. **MN1–MN8, MN11** minor fixes (parallelizable).
8. **NP1–NP5** nitpicks.
9. **D** remove stray artifacts + restore `REVIEW.md`.
10. **NP6** (`.ghtoken` rotation/purge) — schedule, can follow merge.
11. **MN9, MN10** post-merge follow-ups.

---

## G. Pre-merge gate checklist (MUST all be true before merge)

- [ ] C1: SenseVoice pinned (immutable URL + SHA); `!= SenseVoice` carve-out deleted; positive test added.
- [ ] C2: `pnpm i18n` run at head; `en.json` + 9 locales committed; i18n-drift CI gate added.
- [ ] M1: `allowedAdditionalKeys` restored (or dead arg+comment removed); hold-to-talk verified.
- [ ] M2: `skipReview` added; interim segments bypass composer.
- [ ] M3: `tones` removed from seed-effect deps; selection persists.
- [ ] M4: 8 keys translated in all 9 non-English locales.
- [ ] M5: `composer_*`/`transcription_import_audio` confirmed invocable from `main`+`floating-*`; grants added if needed.
- [ ] MN8: `IMPORT_IN_FLIGHT` Drop guard confirmed present/held (or added).
- [ ] D: `UNIFIED_REVIEW.md`, `pr_body.md`, `.review-pr59` deleted; `REVIEW.md` canonical.
- [ ] CI green: clippy, oxlint, `prettier --check src`, `pnpm gen:bindings`, typecheck, and the new i18n gate.

## H. Post-merge follow-ups (track, not blockers)
- NP6 `.ghtoken` rotation + history purge.
- MN9 ggml `.bin` pinning.
- MN10 `http://*:*` egress threat-model note.
- MN1/MN3/MN4/MN5/MN6/NP3/NP4 fast-follows.

## I. Open questions / disputes to resolve during implementation
- **MN8:** is `ImportInFlightGuard`'s `Drop` actually present and held across the await at HEAD? Confirm before closing.
- **REVIEW.md:** confirm the intended canonical form (clean single copy vs pre-duplication) before "restoring."
- **M5:** does the pre-existing implicit-allow capability pattern actually permit the new commands, or must explicit grants be added?
