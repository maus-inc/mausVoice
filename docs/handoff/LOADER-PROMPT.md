# Master prompt — load all handoff docs and execute

Copy the block below verbatim into your agent on a device that has `workflows`
scope and (for the Rust item) a working `cargo` toolchain. It loads the three
handoff documents plus the two upstream reference docs, then executes in order.

---

You are working in the mausVoice monorepo (maus-inc/mausVoice), a Turborepo +
pnpm workspace, on branch `arena/01a01be4-mausvoice`. Rust is the API,
TypeScript is the Brain. User-facing strings go through
`<FormattedMessage defaultMessage="…"/>` or `useIntl()` (never an `id` prop);
after changing strings run `pnpm --filter desktop i18n` and commit the locale
diff. Quality gates: desktop TS = `check-types` + `lint` + `test`; Rust =
`cargo fmt --check` + `cargo clippy -- -D warnings` + `cargo test`; then
`pnpm run build`.

LOAD THESE DOCS FIRST, IN ORDER, AND DO NOT PROCEED UNTIL YOU HAVE READ ALL OF THEM:
1. `docs/handoff/workflow-patch-handoff.md`        — the CI workflow patch + push procedure
2. `docs/handoff/workflow-timeout.patch`           — the actual git patch to apply
3. `docs/handoff/remaining-work.md`                — the 3 remaining items, fully specified
4. `docs/ui-behavioral-issues-plan.md`             — upstream context (agents A11/A12/A23, waves, gates)
5. `REVIEW.md`                                     — the audit protocol + anti-pattern checklist you must follow

THEN EXECUTE, IN THIS ORDER:

STEP 1 — CI workflow patch (requires `workflows` scope):
  git checkout arena/01a01be4-mausvoice
  git apply docs/handoff/workflow-timeout.patch
  git diff --stat   # confirm only .github/workflows/test-package-rust-transcription.yml changed
  grep -n timeout-minutes .github/workflows/test-package-rust-transcription.yml   # expect 45
  git add .github/workflows/test-package-rust-transcription.yml
  git commit -m "ci: raise Ubuntu Rust-transcription timeout 20 -> 45 min"
  git push origin arena/01a01be4-mausvoice

STEP 2 — A23 thock rate-limiter test (Rust):
  Follow `docs/handoff/remaining-work.md` §1 exactly: extract a pure
  `should_throttle_at(now_ms: u64)` from `thock_limiter::should_throttle` in
  `apps/desktop/src-tauri/src/system/audio_feedback.rs`, add the four specified
  tests (reset the static in each), and run the cargo gates.

STEP 3 — A12 stability/memory/idle audit:
  Follow `docs/handoff/remaining-work.md` §2 exactly: build the measurement
  harness on a prerelease build, record baselines + 30-cycle growth for the six
  pages and dialogs, audit the seven enumerated sites (fix only provable leaks),
  and write the report in the exact `REVIEW.md` §2.5 structure. Do not fabricate
  metrics — evidence or a precise remaining-findings entry for everything.

STEP 4 — A11 context-menu surface wiring:
  Follow `docs/handoff/remaining-work.md` §3 exactly: wire transcriptions,
  dictionary, styles, and chats (the specified item lists and ordering), wire or
  explicitly descope composer/home, add one component test per surface matching
  the existing `ContextMenu.test.ts` conventions, and run i18n.

STEP 5 — Final verification (all of these must pass before you finish):
  pnpm --filter desktop check-types
  pnpm --filter desktop lint
  pnpm --filter desktop test
  cargo fmt --check && cargo clippy -- -D warnings && cargo test   # in touched Rust crate
  pnpm run build
  git status   # working tree clean

REPORT BACK with: per-step status, the A12 report (REVIEW.md structure), the new
tests, the i18n diff, and any out-of-lane findings. Do not claim an item is done
unless its gate command above actually passed on your device.
