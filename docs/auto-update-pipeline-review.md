# Pre-release audit — auto-update pipeline

Self-review of the full working diff on `arena/01a00791-mausvoice` against `REVIEW.md`, CodeRabbit persona, following the §2 protocol. Every candidate finding below survived the Cause → Action → Reaction → Necessity gate; findings that failed it are listed at the end so the reasoning is auditable.

## Verdict: **Ready**

Confidence: **Medium** · Mergeable: **Yes** · CI Verification: **Partially verified locally** — `pnpm --filter desktop run lint`, `check-types`, and `test:unit` (375 passing), `node --test scripts/ci/updater-manifest.test.mjs` (9 passing), `pnpm --filter docs run check-types` and `build`, and the docs root-relative-link gate all pass in the sandbox. `cargo clippy`/`cargo test` were **not** run — no Rust toolchain is available here — but the diff contains no Rust changes, so the risk is confined to whether the base builds. The signed-release path (steps 2–5) cannot be exercised without the repository secrets and is verified by contract tests plus review only.

## Major findings

**[Major — Tray badge went stale after a manual check]** `apps/desktop/src/actions/updater.actions.ts`

_The Problem:_ Found in my own diff during review, not on base. Badge state was owned by the caller: `AppSideEffects` set `set_menu_icon` from the poll's return value. That was tolerable at a 60-second cadence, but this change slows the poll to six hours and adds a Settings "Check now" button that also mutates update state. A user who clicks _Check now_, finds an update, and dismisses the dialog would see no badge for up to six hours; conversely, after updating, a stale "update" badge would persist just as long.

_The Solution:_ Moved badge synchronization into `checkForAppUpdates` via `syncMenuIcon`, so every code path that learns the answer reports it. The caller no longer duplicates the logic. The invoke rejection is caught and logged — a missing tray must not reject the check. Covered by three tests including the rejection path.

**[Major — Startup snoozed the update dialog for three days, every launch]** `apps/desktop/src/components/root/AppSideEffects.tsx:617` (base)

_The Problem:_ The first interval tick called `dismissUpdateDialog()` to mark initialization, which writes `dismissedUntil = Date.now() + 3 days`. Only `state.local` is persisted by the Zustand `persist` partializer, so `dismissedUntil` reset on every launch and was then immediately re-armed. The auto-show dialog was therefore unreachable in normal use — the feature could never fire.

_The Solution:_ Removed the sentinel entirely. `useInterval` already fires once on mount, so no "first run" marker is needed. Regression-tested by asserting `dismissedUntil` stays `null` across a check.

## Minor findings

**[Minor — Committed updater signing key]** `.github/workflows/release.yml`, `.github/workflows/build-desktop.yml` (base)

_Context:_ Scored Critical by `REVIEW.md` §5 in the abstract, downgraded here on the Necessity check: the key was only exploitable if the app trusted it _and_ a manifest existed, and neither held, since `endpoints` was empty and no `latest.json` was ever published. It became live-fire the moment this change turned the updater on, so it is fixed as a precondition rather than an aside. Both literals are deleted; `TAURI_SIGNING_PRIVATE_KEY` now comes from `secrets.UPDATER_PRIVATE_KEY`, and `build-desktop.yml` signs nothing at all. A contract test asserts the committed `pubkey` stays empty.

**[Minor — Version synced into a config the build never loads]** `.github/workflows/release.yml:244`

_Context:_ The step wrote `version` into `tauri.prod.conf.json`, but no build command passes `--config` for it, so the write was inert and misled the runbook into documenting a three-file version contract. Removed from the list and from `docs/RELEASE.md`.

**[Minor — Homebrew cask published from prereleases]** `.github/workflows/release.yml`

_Context:_ Pre-existing, and called out as a known wart in the base docs. Directly adjacent to this change's channel guarantee ("a pre-release can never reach a stable user"), which would otherwise be false via `brew upgrade`. Guarded with `if: inputs.prerelease != true`.

**[Minor — Manual check could not defeat its own snooze]** `apps/desktop/src/actions/updater.actions.ts`

_Context:_ With the dialog dismissed, clicking _Check now_ would find the update, set state, and show nothing, because `shouldAutoShowDialog` failed on `dismissedUntil`. A user-initiated check now bypasses the snooze and the auto-show preference — pressing the button _is_ the request. It also suppresses the background toast, since the Settings section reports inline and a toast would be redundant.

## Nitpick findings

- **Workflow header contradicted the workflow.** `release.yml`'s comment block asserted "no updater channel metadata — the updater must never publish latest.json", which the same file now does. Comment/code drift is a Kilo Code high-priority class; rewritten to describe the secrets-gated behaviour.
- **`docs/RELEASE.md` "Rules that keep the pipeline healthy"** instructed maintainers never to publish `latest.json` and asserted no signing secrets exist. Both are now false; rewritten, with the underlying intent (never commit a key, never publish a prerelease manifest) preserved and strengthened.
- **`apps/docs/.../development/tauri-backend.md`** described an empty endpoint list and a legacy prod endpoint. Updated.
- **Dead state field.** `UpdaterState.lastUpdateVersion` had no reader or writer anywhere in the workspace; removed.
- **Stale `plugins.updater` overrides** in `tauri.dev.conf.json` / `tauri.prod.conf.json` pointed at `mausvoice/mausvoice`, a repository that does not exist. Removed rather than corrected: the base config now carries the single real endpoint, and duplicating it per-flavour is how it drifted in the first place.

## UI review findings

- **Explicit states.** The Settings section renders each of pending (spinner + disabled button), up-to-date, available, error, and never-checked. The button is disabled while checking _and_ while a download/install is in flight, so it cannot start a second flow underneath the dialog.
- **Contrast and semantics.** Status text uses `text.secondary`, switching to `error.main` only for failures, keeping it on the theme's AA-compliant palette rather than a hardcoded colour. `role="status"` announces the result to assistive technology, which matters because the outcome appears without any focus change.
- **No new transitions or layout primitives** were introduced; the section reuses `SettingSection`, so grid spacing matches its siblings.
- **Timestamps** are rendered with `Intl.DateTimeFormat` at the user's locale, not a hardcoded format.
- **i18n.** All eleven new strings go through `FormattedMessage`/`useIntl` with no `id` prop, extracted and synced across all ten locale catalogs via `pnpm --filter desktop i18n`.
- **Not addressed:** the existing `UpdateDialog` was left alone. It is outside the agreed minimal-UI scope and changing it would broaden the diff without fixing a defect.

## Missing important test coverage

Added:

- `scripts/ci/updater-manifest.test.mjs` — 9 tests driving the real script over fixture artifact trees: full platform mapping, both macOS triples resolving to one universal bundle, URL host/scheme/tag validation, unsigned-bundle rejection (aggregated, not first-only), no-bundles-at-all, prerelease refusal, required inputs, and the `"false"`-is-truthy trap. Assertions derive from the client contract rather than restating the script's own constant, per the Kilo Code tautology rule.
- `apps/desktop/src/actions/updater.actions.test.ts` — 12 tests: no self-inflicted dismissal, `lastCheckedAt` on success/empty/error, up-to-date confirmation only when user-initiated and cleared when an update appears, snooze respected for background and bypassed for manual, no toast for manual, tray badge on/off, badge-rejection tolerance, and concurrent-check coalescing.
- `apps/desktop/src/tauri-conf.test.ts` — 3 added contracts read from the live config: empty `pubkey`, `createUpdaterArtifacts: false`, and endpoints that are HTTPS, on `github.com`, under `/maus-inc/mausVoice/`, ending in `latest.json`.

Gaps I chose not to close, and why:

- **End-to-end install.** Requires signed artifacts, a published release, and three OSes. Not reproducible in CI; covered by the manual verification checklist in `docs/RELEASE.md`.
- **The workflow itself.** Only its YAML validity and job/step wiring were verified. Asserting on workflow YAML shape tends to produce brittle tests that restate the file, which the tautology rule warns against.
- **`UpdateSettingSection` rendering.** The repo has no React Testing Library setup (`vitest` runs in the `node` environment with no DOM), so adding component tests would mean introducing that infrastructure — out of scope for this change.

## What is working correctly

- **Fail-safe degradation.** With no secrets, the pipeline behaves exactly as before: unsigned installers, no `.sig`, no manifest, and a workflow warning. No path publishes a manifest a client cannot verify.
- **Signature-or-nothing.** A bundle without a `.sig` aborts the run rather than emitting an entry that would fail verification on the user's machine — a failing install is a worse outcome than "up to date".
- **Channel integrity.** Three independent guards keep prereleases out of stable: the publish job's `if`, the script's own assertion, and GitHub's `releases/latest` semantics, which resolve only to non-prereleases. The cask job is now guarded too.
- **Endpoint hardening.** The manifest URL is HTTPS-only on `github.com`, and the pre-existing Rust `.pkg` fallback already validates scheme, host allow-list, `.pkg` suffix, every redirect hop, and both advertised and streamed size caps. Correcting `GITHUB_RELEASE_DOWNLOAD_BASE` to `maus-inc/mausVoice` puts that validated path on a URL that actually resolves; the host allow-list already covered `github.com`, so no capability was widened.
- **Concurrency.** `checkForAppUpdates` still coalesces onto one in-flight promise and refuses to run during a download or install; the new options argument does not open a second entry path.
- **No IPC surface change.** No `tauri::command` was added or altered, so `bindings.ts` needs no regeneration and no new capability is granted — which is why the absence of a Rust toolchain here does not leave a verification hole.

## Post-review follow-ups (external reviewers)

**[Minor — Manifest eligibility gate was asymmetric with the signing gate]** `.github/workflows/release.yml` — raised by Kilo Code, valid.

_The Problem:_ The build job enabled signing only when **both** `UPDATER_PRIVATE_KEY` and `UPDATER_PUBLIC_KEY` were set, but the publish job's eligibility check tested only the public key. With just the public key configured, signing would be skipped (no `.sig` files produced) while `eligible` still resolved to `true`, so the manifest step would hard-fail the release instead of cleanly skipping — defeating the fail-safe degradation this design depends on.

_The Solution:_ The eligibility gate now requires both keys, mirroring the build gate, with a comment stating that the two must stay in lockstep and why. Verified symmetric by parsing the workflow and comparing the `UPDATER_*` env sets of the two steps.

**[Minor — New UI strings shipped untranslated]** `apps/desktop/src/i18n/locales/*.json` — raised by Kilo Code, valid.

_Context:_ `i18n-sync` seeds new keys with the English source by design, so all 11 new strings landed as English placeholders in the nine non-English catalogs. This matches an existing pattern (79–86 keys per locale were already untranslated on base), but the repo does maintain real translations and ships `scripts/translate.py` for exactly this step. Since the strings are short and user-facing, they were translated directly rather than left for a later pass.

Validated: ICU placeholders (`{version}`, `{timestamp}`) preserved in every locale — checked across all 725 keys, and the only 10 mismatches are pre-existing plural-syntax keys untouched by this change; key parity with `en.json` holds; and `pnpm --filter desktop i18n` reports `725 existing, 0 added` for all nine locales, confirming the official tooling retains the translations rather than resetting them. `de`/`fr` keep `Version {version}` verbatim because that is the correct rendering in both languages.

**[Minor — CodeFactor "Complex Method" at `AppSideEffects.tsx:469-553`]** — resolved.

_Context:_ Reported as new on this PR, but the flagged block is the Mixpanel analytics `useEffect`, byte-identical to base; it was attributed here only because two lines were removed above it, shifting its range. Initially left alone under the minimal-diff rule, then fixed on request. The complexity is genuine regardless of provenance: roughly fifteen branch points from optional chaining and plan/trial/tenure rules were inlined in a component effect, where none of it could be tested.

_The Solution:_ The derivation moved into `analytics.utils.ts` as four pure functions (`buildAnalyticsIdentity`, `buildFirstTouchProperties`, `buildPeopleProperties`, `buildSuperProperties`), leaving the effect to orchestrate only: read state, branch on identity change, emit. The helpers take the raw `member` / `localUser` / `preferences` records so the optional chaining lives in tested code rather than the component. Decision points in the effect drop from 27 to 12, and it shortens from 85 lines to 52.

Because this touches analytics — where a silent regression corrupts funnels instead of failing a build — the refactor is locked by `analytics-equivalence.test.ts`, which replays the original inline derivation verbatim and asserts byte-identical payloads across all 288 combinations of plan, trial state, signed-in/out state, onboarding, and contact details, plus the records-not-yet-loaded case. `analytics.utils.test.ts` adds 11 tests for rules that previously had no coverage: a trialling pro is not paying, a signed-out user is community rather than free, tenure is zero without an onboarding date, and absent contact fields send `undefined` rather than `null` so they cannot overwrite an existing Mixpanel profile.

## Findings discarded at the self-review gate

- **"Reduce the 6-hour poll further / make it configurable."** Necessity: a style and product preference, not a defect.
- **"`upToDateConfirmed` duplicates `status === 'idle'`."** Reaction: it does not — `idle` is also the initial state, before any check has run, and the UI must distinguish "never checked" from "checked, nothing found".
- **"Persist `lastCheckedAt` across launches."** Cause: not a defect in this diff, and persisting it would mean widening the `persist` partializer, a change to a shared boundary for cosmetic benefit.
- **"Validate the manifest against a JSON schema in CI."** Necessity: the builder constructs the object literally; a schema test would assert the code against its own copy — the tautology anti-pattern.
