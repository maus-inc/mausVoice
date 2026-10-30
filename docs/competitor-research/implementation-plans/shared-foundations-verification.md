# Shared Foundations — Verification

## Pre-implementation checklist

- [x] PR #144 head branch verified: `session/agent_2605e9ee-1c1c-4742-9d36-dcfc05851daf`
- [x] Expansion label confirmed to exist
- [x] Competitor research reviewed
- [x] Architecture docs read (ARCHITECTURE.md, desktop-architecture.md)
- [x] Existing patterns analyzed (actions, repos, state, store, types)
- [x] PR #137 inspected (hands-free delay, pill placement, custom transcription path)
- [x] Falsifiable research questions defined and answered
- [x] Decisions documented with rationale and rejected alternatives

## Post-implementation verification gates

- [x] `pnpm --filter desktop check-types` passes (2026-09-02, commit 665cb52e)
- [x] `pnpm --filter desktop lint` passes (2026-09-02, commit 665cb52e)
- [x] `pnpm --filter desktop test` passes (383 tests, 2026-09-02, commit 665cb52e)
- [x] `pnpm --filter @maus-inc/voice-ai test` passes (2026-09-02, commit 665cb52e)
- [x] `pnpm --filter @repo/agent test` passes (2026-09-02, commit 665cb52e)
- [ ] `pnpm gen:bindings` produces no diff (validated by CI only; no Rust toolchain in sandbox)
- [x] `pnpm --filter desktop i18n` produces no diff (2026-09-02)
- [x] No existing dictation/transcription/post-processing test regresses
- [x] Feature flags default to off
- [x] Redaction helper unit tests pass
- [ ] Generic secret storage deferred to future scope
- [x] `isPersistenceAllowed()` returns false in incognito
- [x] Shared domain types compile in `apps/desktop/src/types/`

## Port from PR #148 (2026-09-05)

Event contracts, the typed listener, the Rust log sanitizer rules, and ephemeral
session support came from PR #148 and were rebuilt for the `expansion_flags`
design. That PR's nine flag columns, its `packages/types` domain types, and its
separate feature-flag service, state, and utils were dropped because this branch
already covers the same ground.

- [x] `pnpm --filter desktop check-types` passes
- [x] `pnpm --filter desktop lint` passes, prettier and oxlint clean over 384
      files
- [x] `pnpm --filter desktop test:unit` passes, 414 tests across 31 files
- [x] `pnpm --filter @maus-inc/voice-ai test` passes
- [x] `pnpm run check-types` passes at the repo root, 8 turbo tasks
- [x] `pnpm --filter desktop i18n` produces no further diff once the locale sync
      is committed. The sync adds one pre-existing key,
      `failed_to_restart_mausvoice_as_administrator`, which `native.actions.ts`
      already declared and no locale catalog carried.
- [x] `pnpm --filter @repo/agent test` is a no-op because that package defines
      no test script
- [ ] `cargo clippy -- -D warnings` and `cargo test --lib` are left to CI. This
      sandbox has no Rust toolchain. As a substitute, a script parsed all eleven
      rules out of `log_sanitizer.rs` and replayed every assertion in its test
      module against an equivalent regex engine: 22 of 22 pass, and no raw
      string literal carries more hashes than its content requires.
- [ ] `pnpm gen:bindings` produces no diff. No Tauri command and no Specta type
      changed, so no binding change is expected.
- [x] The six new sanitizer rules follow the shape of the five existing ones
- [x] No new user-facing string was added, so no `FormattedMessage` or catalog
      entry belongs to this port
- [x] `storeTranscription` and the remote transcript store now gate on
      `isPersistenceAllowed()` instead of reading `incognitoModeEnabled`
      directly, so an ephemeral session actually suppresses writes
- [x] Incognito behavior preserved exactly, including
      `incognitoModeIncludeInStats` counting words for incognito mode only and
      never for an ephemeral session
- [x] Four new `storeTranscription` tests cover incognito with stats on,
      incognito with stats off, an ephemeral session, and the suppression log
      line carrying no transcript content
- [x] The redundant audio snapshot guard in `storeTranscription` was removed
      because the single gate above it already rules out both modes
