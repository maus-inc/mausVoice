## Purpose

Superfix branch to land **after** the five open arena PRs (#55, #57, #58, #59, #60) merge. It integrates all five (merged in conflict-safe order `#55 → #57 → #60 → #58 → #59`) and remediates every finding (Critical → Nitpick) from the consolidated assertive CodeRabbit-style review, so it is mergeable on top of them.

## Fixed (mapped to the unified review)
- **#57 🔴** Composer popout no longer duplicates dictation — `keys_held` scoped to the `main` window + dictation pipeline gated on window label.
- **#57 🔴** IPC bindings drift — `transcription_import_audio` + `composer_*` added to `collect_commands` + `bindings.ts`.
- **#57 🔴** `run_terminal_command` — `cat` removed from allow-list; `/` and `..` forbidden in args.
- **#57 🔴** ONNX/SenseVoice — `verify_ort_runtime()` fails with actionable error on missing/zero-length dylib.
- **#57 🟠** hallucination filter gated by language; `agentEnabledTools` null/`[]` typed/documented; style switch retags with segment-start snapshot; dead `composer_take_text` removed; voice Edit Mode feature-detected.
- **#58 🟠** `http:default` narrowed from `https://*` wildcard to a curated provider list (kept `http://*` for LAN/Ollama); CSP contract test scans all `packages/*/src`, classifies `plugin-http` per call-site.
- **#59 🔴** updater manifest emits per-installer keys (`windows-x86_64-nsis/-msi`, `linux-x86_64-deb/-rpm`, macOS `-dmg`); `*.sig` excluded from release-body; macOS manual-install uses `.dmg`; `validate_installer_url` accepts `.dmg`/`.app.tar.gz`. §5.5 committed-key literal already absent here.
- **#55 🔴** model-download integrity now applied to pre-existing artifacts (size + SHA-256 admission gate); per-chunk cap enforced before write; pinned-digest well-formedness test.
- **#60 🔴** 3 missing i18n strings + HotkeySetting aria-labels added to all 10 locale catalogs; `appendUntil` merge regression fixed (42 test failures resolved); regression tests for `createAudioChunkPump`/`createStreamingFinalize`/`KEY_ALIASES`; `assert_http_url` scheme test.

## Known blockers still being resolved (see review waves)
The 3 post-implementation review waves found genuine integration regressions introduced by the 5-PR merge that must be fixed before this is mergeable:
- `packages/rust_transcription/src/models.rs` `artifact_set()` `SenseVoice` arm must return a 3-tuple (currently 2-tuple → crate won't compile).
- `apps/desktop/src/actions/transcribe.actions.ts` and `transcriptions.actions.ts` have duplicate declarations from a mis-resolved merge (do not parse).
- `apps/desktop/src/components/root/AppSideEffects.tsx` dead `buildMixpanelProfile` block references removed imports (must be deleted).
- `capabilities/default.json` lost the `https://…/**` subpath globs for providers (must be restored so `plugin-http` matches full URLs).
- `DictationSideEffects.tsx` `finalizeAndPostProcess` return-type mismatch drops the post-processing/paste stage (must be fixed).

These are tracked and being patched in follow-up commits; `cargo`/full `pnpm` build could not run in the authoring sandbox, so final verification is via CI.

## Required CI steps
`cargo build` + `cargo test`; `pnpm install && pnpm --filter desktop i18n`; `pnpm gen:bindings`; `pnpm --filter desktop check-types && lint && test:unit`; `prettier --check`.

Merge order: `#55 → #57 → #60 → #58 → #59`, then this PR.
