# Corrective review of PR #63 (`fix/superfix-review-findings`)

Branch: `arena/01a07c29-mausvoice`, cut from PR #63 head `9e01cbbc3cd79afc0a3b0527be1aa467013a2b24`.
Reviewed state: base `0e7bd17458de54c126183a21a4c70c44032b00cb`, 175 commits, 624 changed files
(+62 701 / −16 204: 221 added, 14 deleted, 389 modified), MERGEABLE / UNSTABLE.

---

## 1. Method and evidence levels

Every claim below carries an evidence level. Nothing above E3 was inferred from a
commit message or a review comment alone.

| Level | Meaning                                                                        |
| ----- | ------------------------------------------------------------------------------ |
| E0    | Claim exists (comment, commit message, bug report) with no code inspected      |
| E1    | Code located, behaviour inferred by reading a single site                      |
| E2    | Full call path traced from event source to effect                              |
| E3    | Call path traced **and** contradicted or confirmed by a test that was executed |
| E4    | Reproduced by an executed test that fails before the fix and passes after it   |
| E5    | Verified on a running desktop build (impossible in this environment, see §7)   |

Sources read in full: all 175 commits, 65 issue comments, 60+ reviews, 263 inline
comments across 184 review threads (99+ resolved, 37 unresolved), the cumulative
diff, `AGENTS.md`, `FULL-REVIEW.md`, `REVIEW.md`, package scripts, Cargo manifests
and the CI workflows.

---

## 2. Commit-by-commit shape of PR #63

The 175 commits are not independent changes; they are five feature branches
integrated onto one trunk plus their review-fix tails.

| Group              | Commits                             | Content                                                                                                                                                                     |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration merges | 4 `Merge branch 'main'`, 4 `merge:` | Repeated re-merges of `main` and of the feature branches (#137, #142, #145, spoken commands, 1.6 rebuild)                                                                   |
| Feature work       | 4 `feat:`                           | Spoken formatting commands + silence hallucination filter, native pill assistant surface, remote sender/receiver, review-before-insert composer                             |
| Review-fix tail    | 86 `fix:`                           | Overwhelmingly bot-driven (SonarCloud, DeepSource, CodeRabbit, Sourcery) and human review rounds; several `Revert` commits for changes that broke other reviewers' findings |
| Tests              | 9 `test:`                           | Mostly added with their fix commits                                                                                                                                         |
| CI / chore / docs  | 17                                  | Workflow hardening, gitleaks rules, DeepSource suppressions, migration renumbering (`077` so #63 keeps `075`/`076`)                                                         |

Consequences that matter for this audit:

- The branch carries **deliberate omissions**. The PR body records that PR #59's
  commit `248ca2c` (fail-closed release signing) was intentionally left out. That
  is a product decision, not a defect, but it is a release-blocking one (E1).
- Several fixes landed as _reverts of earlier fixes_ on the same branch. Each
  reverted area was re-checked on HEAD rather than trusting the history.
- Migration numbering is append-only and was corrected mid-branch (`077`); no
  renumbering remains on HEAD (E2).

---

## 3. Feature inventory (as of PR #63 head)

| Area                                | State on HEAD                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native pill (Windows / macOS / GTK) | Three separate crates, shared logic in `rust_pill_shared`; phases, style bar, cancel/pause/resume, assistant panel, permission cards, toasts, drag + reset position |
| Assistant on the pill               | Streaming, tool calls, permission prompts, typing mode, open-in-app                                                                                                 |
| Dictation                           | Manual/automatic styling, in-dictation style switching (pill chevrons, arrows, hotkeys), pause/resume, backlog, limits                                              |
| Transcription providers             | Groq, OpenAI, Deepgram, ElevenLabs, Mistral, Cerebras, Gladia, custom OpenAI-compatible                                                                             |
| Post-processing                     | Tone/style pipeline, provider metadata capture, failure recording, 50 s timeout                                                                                     |
| History                             | Retranscribe with generation guards, duration refresh, audio storage                                                                                                |
| Review before insert                | Composer popout window (before this branch), now the native pill review card                                                                                        |
| Remote sender/receiver              | Pairing and final-text delivery                                                                                                                                     |
| Spoken commands                     | Formatting commands + silence hallucination filter                                                                                                                  |
| Updater / signing                   | Manifest rules, gitleaks guard; fail-closed signing deliberately omitted                                                                                            |

---

## 4. Findings and classification

### 4.1 Confirmed defects (fixed on this branch)

| #   | Finding                                                                      | Evidence | Root cause                                                                                                                                                                                                                                                 | Fix commit |
| --- | ---------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A   | Opening **Settings → API keys** crashes when Gladia is a candidate provider  | E4       | `gladia` is in `API_KEY_PROVIDERS` and `GladiaModelProviderRepo.supportsTranscriptionModels()` is true, so `ApiKeyList` renders `getProviderFormConfig("gladia").displayName`, but `STANDARD_PROVIDERS` had no `gladia` entry → `TypeError` on `undefined` | `f93f2bb`  |
| C   | Clicking the pill body while **paused** ends the session instead of resuming | E4       | `on-click-dictate` routed unconditionally into `ActivationController.toggle()`; the resume control existed only on the side button                                                                                                                         | `14d438a`  |
| D   | **Two sounds** per pill-body click                                           | E2       | The pill emitted `haptic_feedback("press")` while the desktop played the start/stop recording clip for the same click                                                                                                                                      | `2c7e2a3`  |
| E   | Review window opens **centred on screen**, not next to the pill              | E4       | `PositionChanged` was only emitted on drag-end / reset / X11 move, so the geometry cache was empty on first use and `getComposerWindowPosition()` returned null                                                                                            | `1f38d0d`  |
| J   | Repo-wide Prettier check red on PR head                                      | E3       | Trailing whitespace in `README.md`                                                                                                                                                                                                                         | `ee3045d`  |

### 4.2 Confirmed incomplete behaviour (completed on this branch)

| #   | Finding                                                                                         | Evidence | Change                                                                                                                                                                                                                                                                                                                                                                                        | Commit    |
| --- | ----------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| F   | Review before insert lived in a separate window that opens away from the caret and steals focus | E2       | Review is now a state of the native pill: `Insert / Edit / Copy / Cancel`, id-tagged decisions, a queue for a second transcript, panel-close counts as cancel, pill body inert while a review is open. `Edit` still opens the composer (the only surface with a real text field) and its result flows through the caller's normal insertion path. Non-native overlay builds keep the composer | `8633a6c` |

### 4.3 Product decision implemented on request

| #   | Decision                                                                                                                     | Change                                                                                                                                                                                                                                  | Commit    |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| B   | A style switch made **during** dictation must style the whole final transcript and become the default for the next recording | `getEffectiveToneIdAtFinalize` (manual mode) now prefers the stop snapshot over the start snapshot: `toneIdAtStop ?? liveSelectedToneId ?? toneIdAtStart`. Automatic mode unchanged. Doc comments and tests updated to the new contract | `44f886d` |

### 4.4 Already correct on HEAD (no change made)

| Claim                                                                         | Evidence | Result                                                                                                                             |
| ----------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bindings drift between `invoke_handler`, `collect_commands` and `bindings.ts` | E3       | 130 handlers in all three lists, no TS-invoked command missing                                                                     |
| Post-processing provider/model attribution lost on failure                    | E2       | Captured before the request and preserved on failure                                                                               |
| Cerebras 402 / empty body mishandled, secrets in logs                         | E2       | Mapped and redacted                                                                                                                |
| Retranscription loses durations / races                                       | E2       | Durations refreshed, generation guards in place                                                                                    |
| Post-processing retry duplicates the History row (question D)                 | E2       | `performRetranscribe` writes back to the same row via `updateStoredTranscription`; no duplicate is created                         |
| Markdown rendering unsafe                                                     | E2       | `react-markdown` + `remark-gfm`, no `rehype-raw`; pill text goes through `markdownToPillText` with a 600-char cap                  |
| Composer blank-window / duplicate-window handling                             | E3       | Ready timeout, recovery toast and single-flight guard already present                                                              |
| Windows pill "sticks to the top of the screen"                                | E2       | `default_pill_y` / `reposition_to_cursor_monitor` are correct; the centre-of-screen report maps to the composer window (finding E) |

### 4.5 Runtime verification required (not fixed, deliberately)

| #   | Claim                                                              | Why no fix                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H   | Assistant "dies after a tool call", `The resource id N is invalid` | E2 tracing of `AgentLoop`, `run-agent.ts` and the OpenAI/Claude/Gemini tool-message mapping found no unguarded call site. The error text comes from Tauri's resource table, which points at a disposed channel/resource in a native call, not at the agent loop. Fixing this without a debug-build stack trace would be speculation |

### 4.6 Open product decisions (reported, not changed)

1. **macOS-only thock on Pause/Resume.** The macOS pill emits `press` on the pause and resume buttons; Windows and GTK are silent. Not a duplicate (the desktop plays no clip for pause/resume), so this is a cross-platform inconsistency for you to settle, not a defect.
2. **In-pill text editing.** The review card cannot edit text in place; `Edit` opens the composer window. Giving the pill a real multi-line editor is a much larger change in all three native crates.
3. **Fail-closed release signing** (PR #59 `248ca2c`) is still deliberately absent from this branch.

---

## 5. Fixes shipped, with root cause and regression test

| Commit    | Root-cause fix                                                                                                                                                                              | Regression test                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `f93f2bb` | Registered `gladia` in the API-key form config and typed the standard map as `Record<StandardProvider, …>` so a missing provider is a compile error; the runtime throw is now descriptive   | `api-key-provider-config.test.ts` iterates `API_KEY_PROVIDERS` × both contexts. Verified failing with the entry removed                |
| `14d438a` | Extracted `resolvePillBodyClickIntent` and routed a paused body click to `resumeDictation`                                                                                                  | `pill-click.utils.test.ts` (4 cases: paused, idle, non-main window, stopping)                                                          |
| `2c7e2a3` | Removed `send_haptic("press")` from `ClickAction::Pill` in all three crates; the loading guard, style thock and cancel thock are untouched                                                  | `pill-click-feedback.contract.test.ts` parses the `ClickAction::Pill` arm of each crate and asserts no haptic and a kept loading guard |
| `1f38d0d` | New `request_position` pill message + `request_pill_position` command; the app asks for the geometry once its listener is live. Composer placement logic unchanged                          | `composer.utils.test.ts`: caches the reply, listener-before-request ordering, timeout fallback, cached-geometry short circuit          |
| `44f886d` | Manual-mode finalize prefers the stop snapshot                                                                                                                                              | `dictation-style.utils.test.ts` rewritten to the new contract, including the end-to-end snapshot-store case                            |
| `ee3045d` | Prettier on `README.md`                                                                                                                                                                     | `pnpm run format:check` is green                                                                                                       |
| `8633a6c` | Review state carried inside the existing assistant-state message; `review_decision` answered with the review id; TS queue with a busy flag, stale-id rejection and unknown-action rejection | `pill-review.actions.test.ts` (7 cases: insert, cancel, copy, edit, queueing, stale decision, unknown action)                          |

Constraints held throughout: no `any`, no `unwrap()` added, no fixed sleeps (the
geometry wait resolves on the real event and is only bounded by a timeout), no
silent fallbacks (every fallback logs), ids used for all stale-async decisions,
platform adapters kept separate, no test/lint/type/CSP/capability/validation or
signing rule weakened.

---

## 6. Interface changes

- New Tauri command `request_pill_position` (registered in `app.rs`, exported via
  Specta in `examples/gen_bindings.rs`, hand-written into `bindings.ts` in the exact
  generator format and position — CI `scripts/check-bindings.sh` is the authority
  that this matches, since `cargo` cannot run here).
- New pill IPC in message: `request_position`.
- Extended pill IPC in message: `assistant_state.review` (optional, `#[serde(default)]`,
  so an older pill binary ignores it).
- New pill IPC out message: `review_decision { review_id, action }`, surfaced to the
  frontend as the `pill-review-decision` event.
- New app state slice: `pendingPillReview`.

---

## 7. Verification

Run in this environment:

| Check                                                | Result                                             |
| ---------------------------------------------------- | -------------------------------------------------- |
| `pnpm run check-types` (all packages)                | PASS                                               |
| `pnpm --filter desktop run test:unit`                | PASS — 115 files, 1241 tests (baseline 112 / 1185) |
| `pnpm --filter desktop run lint` (prettier + oxlint) | PASS — 0 warnings, 0 errors                        |
| `pnpm run format:check`                              | PASS (was failing on `README.md` at PR head)       |
| `pnpm exec turbo run build --filter=desktop^...`     | PASS — 6/6                                         |

Not run, environment limitations:

| Check                                                                   | Reason                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo build` / `cargo clippy -- -D warnings` (desktop + 3 pill crates) | No Rust toolchain: `sh.rustup.rs`, `static.rust-lang.org`, `crates.io` and `index.crates.io` are all unreachable from this sandbox. Every Rust change in this branch is compiled for the first time by CI |
| `pnpm gen:bindings`                                                     | Shells out to `cargo`; `bindings.ts` was hand-edited to match the generator output and is validated by `scripts/check-bindings.sh` in CI                                                                  |
| `pnpm --filter desktop run test:integration`                            | Requires `GROQ_API_KEY`; fails identically on the unmodified PR head                                                                                                                                      |
| `pnpm --filter desktop run test:webdriver`                              | `pnpm install` cannot run postinstall scripts here (chromedriver download is blocked)                                                                                                                     |
| Any desktop-runtime behaviour                                           | No display, no packaged app                                                                                                                                                                               |

---

## 8. Recommended checks before release

1. Windows, macOS and Linux: build the pill crates (this is the first compile of the
   review-card code) and run `cargo clippy -- -D warnings` on all four crates.
2. Pill-body click while paused resumes; click while idle starts; click while
   recording stops; exactly one sound per click on each platform.
3. Review before insert with the native pill: insert, copy, edit, cancel, panel close,
   and a second dictation finishing while a review is open (it must queue).
4. Composer placement next to the pill on first use, including a multi-monitor layout
   with negative coordinates and a pill that has never been dragged.
5. Style switch mid-dictation: the whole transcript comes back in the new style and the
   next recording starts on it.
6. Settings → API keys with a Gladia key configured.
7. Assistant tool-call termination (finding H) with a debug build and a stack trace for
   `The resource id N is invalid`.
