# Wave Completion Status — verified against docs/ui-behavioral-issues-plan.md §4

Point-in-time check of every wave gate against the actual code (not the PR body, which
contains at least one self-contradiction — it lists A23 "out of scope" while A23 was
implemented). Em-dash counts and file evidence below were gathered from the working tree.

## Completed (verified in code)

- **A01–A10, A13–A18, A20, A22, A24** — merged in prior PRs. Spot-checked: A08 backlog
  state exists (`output-routing.utils.ts:167+`), A24 AssemblyAI model field exists
  (`api-key-provider-config.tsx:115,126`).
- **A04 (assistant pill markdown)** — implemented + hardened (dead `isStreamingStable`
  removed, streaming contract corrected in `assistant-pill-text.utils.ts`).
- **A11 (context menu)** — component + input clipboard menu shipped; crash fixed,
  selection handling corrected, labels i18n'd (see the stacked-PR commit).
- **A19 (em-dash + humanize)** — humanize skill now wired into the agent system prompt
  (`agent-configs.ts`) and every post-processing prompt (`prompt.utils.ts`); scrubber
  hardened. **Em-dash sweep COMPLETED this pass**: zero em-dashes in `defaultMessage`
  copy and all ten locale catalogs (4 strings + 9 locales fixed; `es` was already clean).
- **A21 (hotkey spam filter)** — implemented + release-before-refire fixed (per-key
  release via `getStyleSwitchActionNamesForKey`).
- **A23 (thock haptics)** — implementation present (`system/audio_feedback.rs`,
  `thock-*.wav`, `commands.rs` `set_interaction_chime_enabled`, `AppSideEffects` wiring).

## NOT finished (genuinely open)

### A12 — Stability / memory / idle audit (Wave 4 gate) — **MISSING**
No audit report, no measured baselines, no "before/after memory metrics" — the core
deliverable A12's DoD requires. Note: much of the *underlying* hardening the plan
enumerates already exists (`AsyncDataController` generation counter in
`async.hooks.ts`, `useTauriListen` unlisten/`canceled` teardown in
`desktop-utils/src/tauri-listen.ts`, `useAsyncEffect` cleanup chaining). What is
absent is the **measurement harness + consolidated findings report** (and any fixes
only provable at runtime). This requires a running app + DevTools memory snapshots /
`leaks` tooling, which is not possible in this sandbox. Recommendation: run the A12
protocol on a prerelease build (per `ui-behavioral-issues-plan.md` A12 WALK) and land
the report; the static audit is largely already satisfied.

### A23 — thock rate-limiter unit test — **MISSING**
`thock_limiter::should_throttle()` (`audio_feedback.rs:157+`) has no test, but the
plan's TESTS section explicitly requires "rate-limiter logic (pure function)". Also
the PR body wrongly lists A23 as "out of scope". `cargo` is unavailable in this
sandbox, so the test cannot be compiled/verified here; it must be written and run in a
Rust-capable environment (inject time rather than sleeping, since `should_throttle`
reads `SystemTime::now()` directly).

### A11 — full surface wiring — **INCOMPLETE (explicitly descoped)**
Only the text-input clipboard menu is wired. The plan's inventory
(transcriptions/dictionary/styles/chats/composer/home + a default app-level menu) is
not wired, and there is no descoping rationale on record. The plan's DoD permits
"explicitly descoped with rationale in report" — that rationale is the missing piece;
either wire the high-value surfaces or record the descope. This is a multi-file UI
effort best done as its own lane.

## Verification status of the fixes on this branch

- `pnpm --filter desktop check-types` — PASS
- `pnpm --filter desktop lint` (prettier + oxlint) — PASS (0 warnings / 0 errors)
- `pnpm --filter desktop i18n` — no drift (idempotent)
- `pnpm --filter desktop test:unit` — 73 files / 726 tests PASS
- Rust (`cargo fmt/clippy/test`) — **not run**: cargo unavailable in sandbox.
