# PROMPT: Combine PRs #137, #145, #142 into one pristine PR on top of superfix

## A. Original human request (verbatim, do not edit, treat as the source of intent)

> hey i need quite some help i have alot of pr backlog to deal with, switching
> between different agents and babysitting so many prs simultaneously at once
> is overwhelming me, and i have some prs that are still in progress, like the
> expansion ones, and i have prs stacked on other prs that need to be merged
> in, i really just need to completely complete and correctly address all
> reviews in all prs all ci should be green and all the stuff merged into the
> superfix pr63 branch, ask for direction only when needed, correct autonomy, go

Follow-up clarification from the same human, in the same conversation:

> Guide parallel subagents with their own worktress so you can parallelise, i
> need you to make sure all review criterion deeply has nothing with 2
> independent subagents per pr deeply fully using full-review.md and going
> even deeper than its principles adhere to agents.md and orchestrate deeply

## B. Scope of this specific task

This prompt does not ask you to address the full backlog in one shot. It asks
you to do the *narrowest high-leverage piece* of that backlog: combine PRs
#137, #145, and #142 into a single pristine PR that can land on top of the
superfix branch (PR #63). The rest of the backlog (PRs #63, #131, #144, #149,
#151, the staged arena PRs) is either already done or held by the human for
separate reasons. Do not act on those.

You are expected to operate with strong autonomy. "Ask for direction only
when needed" means: do not bounce routine judgement calls back to the human.
The human will direct you at a few key checkpoints (this prompt is one of
them) and otherwise expects you to drive the work to completion.

You are expected to use parallel subagents per PR and apply `FULL-REVIEW.md`
deeper than its stated principles. Where this prompt specifies a different or
narrower scope, the prompt wins (it is the more recent and more specific
instruction).

---

## 1. Operating model (read this first)

You are the **planner + reviewer**. You do not perform every diff yourself
end-to-end. You decompose the work into tightly-scoped packets, dispatch
parallel subagents (Codex workers or `general` task agents) to perform the
diffs, then you re-verify the result by running the same checks the subagent
ran. Subagent failure is your failure. Re-run, narrow the packet, or escalate
to a more capable model. Do not accept a subagent "done" report on faith.

Persistence: do not stop early. If a packet fails, retry once with a narrower
scope, then escalate. Only mark the task "Blocked" when the blocker is real
(missing toolchain, inaccessible file, contradictory history). When in doubt,
pick the safer interpretation and document it in the commit message.

---

## 2. Target outcome

Produce a single branch named `superfix-1.6-rebuilt` (record the name you use)
that:

- is based on `origin/fix/superfix-review-findings` (head: `6363d26e` at the
  time of writing; fetch and recheck)
- contains every behavioral change that PRs #137, #145, and #142 intended to
  ship
- contains no behavior change beyond the union of those three PRs
- is a **pristine** history: linear, conventional commit messages, no merge
  commits, no rebase conflict markers anywhere in the tree, no commits that
  just say "fix conflicts" or "WIP"
- has every Rust crate building cleanly with `cargo check` / `cargo clippy`
  on stable
- has every TypeScript file passing `pnpm --filter desktop check-types`
- has the test suite at parity with the union of the three PRs (no new test,
  no removed test, no flaky test)
- has no new dependency added (use what the three PRs already used)
- is a single branch you can hand back to the human for review and merge

You are not asked to write the PR description. You are asked to leave the
branch ready to push. The human will draft the PR description.

---

## 3. Hard constraints (cannot be relaxed)

1. **No behavior change outside the union of #137, #145, #142.** If a refactor
   is needed to reconcile the three PRs, do it. If a refactor would change
   behavior, stop and ask.
2. **No comments added unless they document a non-obvious invariant.** The
   repo's `AGENTS.md` is explicit about this.
3. **No `unsafe` in Rust unless the original three PRs used `unsafe` for the
   same purpose.**
4. **No `as any` / `as unknown as` in TypeScript.** If a type is wrong, fix
   the type, not the cast.
5. **Database migrations:** every new migration in the three PRs must keep its
   schema change AND its renumbering rule. Migrations already applied to the
   superfix base are numbered 0–77 with 78–80 reserved (intentional skips
   per `AGENTS.md`). Any new migration in the rebuilt branch must be 081 or
   higher. Never renumber an applied migration.
6. **i18n:** every new user-facing string in the three PRs must be present in
   all 10 locale catalogs under
   `apps/desktop/src/i18n/locales/*.json` with consistent meaning. If a string
   was added in only some locales in the original PRs, add it to the missing
   ones now.
7. **CSP / Tauri security:** no expansion of
   `dangerousDisableAssetCspModification` beyond `["style-src"]`. No new
   wildcard in `img-src`, `connect-src`, or `frame-src`.
8. **Public Tauri command surface:** any new `#[tauri::command]` in the three
   PRs must be registered in `app.rs` invoke_handler AND re-emitted through
   `pnpm gen:bindings` so `packages/desktop-native-apis/src/bindings.ts` stays
   in sync.
9. **Do not touch PRs #149 (expansion/1-shared-foundations) and #151
   (expansion/2-meeting-notes).** They are held by the human for a separate
   scope decision. Do not modify, rebase, or merge them.
10. **Do not touch PR #63 (superfix).** The human is holding that merge
    pending Build-Desktop Windows/macOS CI completion and a final review pass.
11. **Do not push to main. Do not merge.** All pushes go to the new branch
    only. The human merges.

---

## 4. The three PRs — exact content to preserve

### 4.1 PR #137 (branch: `triage/voquill-issues-2026-08`, head: `de3c9c02`)

Base: `origin/fix/superfix-review-findings`. Contains 113 commits landing ~25
fixes from the voquill issues triage. The non-negotiable behavioral changes:

- **Per-chunk websocket log downgrades** in
  `apps/desktop/src/sessions/*-transcription-session.ts`: per-chunk send/receive
  logs are `getLogger().verbose(...)` not `info`. Connect/auth/close/finalize
  logs remain `info`.
- **Audio snapshot preservation on incognito failure** (file
  `081_preserve_audio_on_failure.sql` after renumbering from 075): adds
  `preserve_audio_on_failure INTEGER NOT NULL DEFAULT 1` to
  `user_preferences`, plumbed through the UserPreferences type,
  `toLocalPreferences` / `fromLocalPreferences`, the `transcribeAudio`
  action, and the incognito UI setting. Migration is registered at
  `version: 81` in `db/mod.rs`.
- **Empty transcription retention:** the `desktop_resume` Windows Tauri event
  listener re-arms the global hotkey after sleep/wake or session unlock.
  The `recording_failed` backend event surfaces a more specific toast in
  `DictationSideEffects`. `handleEmptyTranscriptionResult` is a testable
  helper that preserves audio and shows a recovery toast when transcription
  produces no text but emits warnings.
- **Post-processing token budget:** `maxTokens?: number` on
  `GenerateTextInput`, threaded through every provider in
  `apps/desktop/src/repos/generate-text.repo.ts` and the underlying
  `packages/voice-ai/src/*-utils.ts` call sites.
- **OpenRouter STT support:** a new `OpenRouterTranscribeAudioRepo` with model
  warnings, wired through `apps/desktop/src/repos/index.ts`.
- **Keyboard modifier side display:** `getPrettyKeyName` helper produces the
  user-facing label (`MetaLeft` → `⊞ L`, `ControlRight` → `Ctrl R`, etc.).
- **Custom hands-free delay:** `handsFreeDelayMs: Nullable<number>` on
  UserPreferences, with a `setHandsFreeDelayMs` action, settings UI input
  (0–60000 ms), and `routeTranscriptOutput` honors the delay.
- **Pill placement:** `pillPlacement` enum on UserPreferences, with
  `PillPlacementTop` / `PillPlacementBottom` options, settings UI toggle,
  native pill re-anchoring on `set_pill_window_size`.
- **OpenAI-compatible custom transcription path:** `transcription_path` field
  on `ApiKeyCreateRequest`, threaded through the openai-compatible repo.
- **Windows pill topmost re-assertion:** in
  `packages/rust_windows_pill/src/pill.rs`, every 2 seconds re-issue
  `SetWindowPos(HWND_TOPMOST, ...)` to defend against Windows reassigning
  z-order on foreground change.
- **Glossary exact spelling in post-processing:** post-processing rules prefer
  exact-match glossary terms over fuzzy matches.
- **Style refactors:** extract `BaseApiTranscriptionSession`,
  `drainSamples` to `audio-buffer.utils`, mark `streamSession` as readonly
  (S2933), extract `processOpenAIChunk` / `processGeminiChunk` / claude
  toolChoice / `findBestMatchingRule` / `withDefault` /
  `buildJsonSchemaResponseFormat` helpers. Required to make the behavioral
  features compile. Preserve them.
- **i18n additions:** 4 new strings (mic unavailable, pill placement x2,
  transcription failed) translated into 9 locales.
- **Voice-ai test helper dedup:** consolidate test helpers across the voice-ai
  package, remove redundant ones.
- **Linux / wl fixes:** classify OSLeft as super modifier, simplify
  `is_super_modifier` to satisfy clippy `nonminimal_bool` (last commit on PR
  head, `de3c9c02`), disable webkit compositing on X11, fix launch_env
  split-const bug.
- **Log rotation cap:** cap log file size and rotate with bounded directory
  (`MAX_LOG_FILE_SIZE` = 25 MB, 250 MB total cap, `MAUSVOICE_LOG` env
  override). Note: the `app.rs` site uses `.max_file_size(MAX_LOG_FILE_SIZE)`
  which currently requires `.into()` to coerce `u64` to `u128` — apply the
  cast on the new history too.
- **Tauri compile fix-ups:** fix `lifecycle.rs` compile errors, prettier
  formatting, openai-compat double `/v1` fix.
- **Profile cleanup:** remove `cwd` from diagnostics purge, fix log label.
- **`error_reason` field on transcriptions:** persist `transcriptionPath`,
  `pillPlacement`, `handsFreeDelayMs` preferences; fix ONNX empty text;
  consolidate `restart_key_listener`; wire `recording_failed` listener;
  narrow `output.text` fallback to ONNX-only when segments are empty;
  preserve silence-hallucination filter for whisper.
- **CSP / per-process restructure:** clippy 1.98
  `chunks_exact_to_as_chunks` fix, unused-import cleanup.
- **TS refactors:** extract base session, extract chunk processors, builder
  map for provider chain, split flush null+readyState checks to silence
  S6582 false positive, mark api session fields readonly.

### 4.2 PR #145 (branch: `ci/repo-wide-prettier-i18n-idempotence`, head: `2a5c2e68`)

Base: `origin/triage/voquill-issues-2026-08` (= #137's head). Adds:

- **CI gate workflow** `.github/workflows/format-and-i18n.yml` that runs on
  PRs and push-to-main: `pnpm format:check` and `pnpm --filter desktop
  i18n` (run twice with a cleared cache to prove idempotence).
- **`format:check` script** in root `package.json` that runs prettier on the
  whole repo with a repo-wide `.prettierignore`.
- **Prettier reformat commit** `2a5c2e68` fixing 10 files that drift in
  HEAD's history.

### 4.3 PR #142 (branch: `arena/01a03dc1-mausvoice`, head: `8ac46b71`)

Base: `origin/triage/voquill-issues-2026-08` (= #137's head). Adds:

- **Dictionary auto-learn** for user-corrected words: when the user edits a
  transcription text and the edit removes a word that was not in the
  dictionary, prompt the pill to confirm saving that word as a glossary term.
- **New `auto_learn_from_edits_enabled` preference** (UI toggle in More
  Settings).
- **Settings repository updates** for the new preference.
- **Tests** for the new action.
- The branch on remote `arena/01a03dc1-mausvoice` was force-pushed and has
  a non-buildable tree with unmerged `<<<<<<<` markers in 9 Rust files
  (`apps/desktop/src-tauri/src/db/preferences_queries.rs`, `db/mod.rs`, and
  7 files in `packages/rust_*_pill/`). **Do not attempt to cherry-pick that
  corrupted history.** Instead, recover the **intended behavior** by reading
  the PR description and the review comments via
  `gh api repos/maus-inc/mausVoice/pulls/142/comments` and
  `gh api repos/maus-inc/mausVoice/pulls/142/reviews`, then re-implement the
  auto-learn feature on a clean base. The 10-locale wording
  `some_corrected_words_were_added_to_your_dictionary_but_other` (and
  companion strings) is the canonical phrasing; carry it forward verbatim.

---

## 5. Reconciliation strategy

**Prefer 1:1 replay of original commit intent over from-scratch rewrite.**
The three PRs were carefully reviewed and the humans cared about specific
behavioral fixes. The risk in a from-scratch rewrite is that you silently
drop a behavioral fix. Replay the originals.

**Order of replay (lowest-risk to highest-risk):**

1. **Cherry-pick #145's two commits onto a fresh branch from
   `origin/fix/superfix-review-findings`.** Mechanical: 2 commits, low
   conflict risk.
2. **Replay #137 commit-by-commit onto that branch.** This is the long part:
   113 commits. Replay them in the same order as the original PR. Resolve
   conflicts by adopting the intent of both sides:
   - For **functional** changes (new feature, new migration, new command):
     take the commit's version, ported to whatever the superfix base has
     changed.
   - For **refactor-only** commits whose content is already in the superfix
     base via a different commit: use `git rebase --skip` and document the
     skip in the final PR description.
   - For **stale conflict** with a fix already in superfix (e.g. the
     `MAX_LOG_FILE_SIZE` u128 cast): apply the fix at the same code site in
     the new history.
3. **Re-implement #142's auto-learn feature** as a single squashed commit on
   top of the rebased #137+#145 branch. The new implementation must be
   self-contained, must register a new migration at version 081 (or higher
   — check the highest applied number in the new tree first), and must use
   the 10-locale wording verbatim.

If during step 2 you find that a 3-way conflict cannot be resolved without
changing behavior, **stop**, document the conflict in detail in
`.prompts/conflicts.md` (path, both sides, your attempted resolution, what
the behavior delta would be), and report to the human. Do not guess.

---

## 6. Reproduction tools (read these first)

```bash
# Set up the worktree
cd <workspace>
git fetch origin fix/superfix-review-findings triage/voquill-issues-2026-08 \
              ci/repo-wide-prettier-i18n-idempotence arena/01a03dc1-mausvoice
git worktree add .worktrees/rebuild -b superfix-1.6-rebuilt \
    origin/fix/superfix-review-findings
cd .worktrees/rebuild

# Inspect the three PRs' content
git log --oneline origin/fix/superfix-review-findings..origin/triage/voquill-issues-2026-08
git log --oneline origin/triage/voquill-issues-2026-08..origin/ci/repo-wide-prettier-i18n-idempotence
gh api repos/maus-inc/mausVoice/pulls/142/comments
gh api repos/maus-inc/mausVoice/pulls/142/reviews
```

**Never rebase `arena/01a03dc1-mausvoice` onto anything.** That branch has
unmerged markers in 9 Rust files. Treat it as evidence of intent, not as a
source of truth.

---

## 7. Review protocol

Apply `FULL-REVIEW.md` to your own work as you go. `REVIEW.md` at the repo
root is the entry point and is explicit that `FULL-REVIEW.md` is mandatory
even when it is not in the diff. Fetch it from `main` and load its full
content as part of your context. Use the per-PR review-criterion depth the
human asked for ("deeper than its principles"), but constrained to this
rebuild scope.

---

## 8. Toolchain check (run before the first rebase)

```bash
which cargo rustc pnpm node
cargo --version   # must be 1.98.x stable per CI
pnpm --version    # must be 10.x
node --version    # must be v24
```

If cargo is missing, install via `rustup` (non-interactive):
```bash
curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable \
  --profile minimal --component clippy,rustfmt
. "$HOME/.cargo/env"
```

If the desktop Tauri build can't link, install the system libraries the
`apps/docs/src/content/docs/development/setup.md` page lists (same list as
`.github/scripts/install-desktop-linux-deps.sh`): gcc, cmake, pkg-config,
libwebkit2gtk-4.1-dev, libsoup-3.0-dev, libgtk-3-dev,
libayatana-appindicator3-dev, librsvg2-dev, libasound2-dev, libxdo-dev,
libgtk-layer-shell-dev, libgstreamer1.0-dev, libgstreamer-plugins-base1.0-dev,
libssl-dev, libc6-dev.

---

## 9. Subagent dispatch pattern

Use this pattern for any non-trivial subagent task. A "non-trivial task" is
anything that touches more than 3 files or requires Cargo to compile.

```
# subagent-task.md
GOAL
[One sentence describing the single outcome to produce.]

SCOPE FILES (allowlist)
- path/to/file_a.rs
- path/to/file_b.rs

DO NOT TOUCH
- any other file
- any commit, push, merge, fetch, or worktree operation

CONSTRAINTS
- No comments unless documenting a non-obvious invariant
- No `as any` in TypeScript
- No `unsafe` in Rust unless original used `unsafe` for the same purpose
- No new dependencies

VERIFICATION (must run, must pass)
- cargo check --lib in apps/desktop/src-tauri (or appropriate crate)
- pnpm --filter desktop check-types (if TS touched)
- any test the task added must be runnable via the project's test command

RETURN (must be machine-checkable)
- list of files modified with line counts
- exact commands run and their exit codes
- the diff (git diff --stat) of the changes
- for each new test, the test command and exit code
```

**Do not** dispatch a subagent without an explicit allowlist and a
verification contract. Subagents that "just explore" are net-negative: they
burn budget without producing a verifiable artifact.

**Do not** dispatch a subagent that needs to make a judgment call about
behavior. Those decisions are yours (the planner). Subagents execute
well-scoped mechanical work.

---

## 10. Verification gate (must pass before you declare done)

Run all of these from the new branch's worktree:

```bash
# TypeScript
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test
pnpm --filter @maus-inc/voice-ai test
pnpm --filter @repo/agent test

# Rust
cd apps/desktop/src-tauri
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check --lib
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy --lib -- -D warnings
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib

# Pill crates
cargo test --manifest-path packages/rust_pill_shared/Cargo.toml
cargo clippy --manifest-path packages/rust_gtk_pill/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path packages/rust_macos_pill/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path packages/rust_windows_pill/Cargo.toml --all-targets -- -D warnings

# Sidecar
cd ../../
cargo test --manifest-path packages/rust_transcription/Cargo.toml

# i18n
pnpm --filter desktop i18n

# Format gate (PR #145 introduces this)
pnpm format:check
```

If any command fails, the gate fails. Fix or stop.

---

## 11. Final report (what to hand back to the human)

When the branch is ready to push, produce a single `.prompts/REPORT.md` containing:

1. **Branch name** and base commit.
2. **Total commits** on the new branch.
3. **Commits intentionally skipped** (the `git rebase --skip` cases), with a
   one-line reason for each.
4. **Commits re-implemented from scratch** (only #142's auto-learn should be
   in this list; everything else is replayed).
5. **Files modified by hand** outside a clean cherry-pick (e.g. the
   `MAX_LOG_FILE_SIZE` u128 cast). One line each.
6. **Verification gate output:** exit code per command, summarized.
7. **Open questions for the human:** anything you could not decide yourself.
8. **A diff stat** (`git diff --stat origin/fix/superfix-review-findings..HEAD`)
   so the human can see the shape of the change at a glance.

Do not draft a PR description. The human will do that.

---

## 12. The repo's actual rules (verbatim from `AGENTS.md` — non-negotiable)

- **Never push to main.** All pushes go to the new branch.
- **Never merge without explicit human confirmation using the exact wording:**
  `Yes Merge Branch X into Branch Y`. You do not have that authorization in
  this task. Stop short of any merge.
- **DRY:** if you find yourself copying code, extract a shared helper.
- **Minimal impact:** do not break existing functionality.
- **DRY of pre-push:** the human runs a separate pre-push loop. You are not
  asked to do that. Push the branch only after your verification gate passes
  and the human has confirmed the report.
- **No comments unless necessary.** A comment is necessary only if a
  non-obvious invariant exists that the next reader would miss.
- **Do not propose band-aid fixes.** Root-cause only.
- **Rust is the API, TypeScript is the brain.** No business logic in Rust.
- **DB migrations:** schema and data in separate migrations; renumbering an
  applied migration is forbidden. Skipped numbers (021, 069, 070, 078–080)
  are reserved.
- **CSP:** do not expand `dangerousDisableAssetCspModification` beyond
  `["style-src"]`. No wildcards in CSP.
- **Tauri commands:** every new `#[tauri::command]` must be in `app.rs`
  invoke_handler AND `pnpm gen:bindings` must be re-run.
- **i18n:** `FormattedMessage defaultMessage` or `useIntl()`, never an `id`
  prop.
- **The human's git identity** is `kiloconnect[bot]` /
  `240665456+kiloconnect[bot]@users.noreply.github.com`. Do not invent a
  co-author.

---

## 13. Anti-patterns to avoid

These are failure modes a prior orchestration attempt hit. Do not repeat them.

- **Bulk conflict resolution with naive regex.** A prior session used
  `re.sub(..., r'\1\2', ...)` and corrupted ~30 files. Always read both
  sides of a conflict before resolving.
- **Auto-skip on conflict without reading the intent.** A prior session
  `git rebase --skip`'d commits whose content was actually different from
  what was in the superfix base, silently losing fixes.
- **Force-push without explicit human authorization.** `AGENTS.md` forbids
  it.
- **A 50-commit PR described in 4 sentences.** The report must list every
  intentional change, not summarize.
- **Trusting a subagent's "done" without re-running the verification
  locally.** Subagents lie. Re-run the same command and confirm the exit
  code.
- **Creating a `Cargo.lock` or `pnpm-lock.yaml` change that drifts from the
  upstream.** Only update lockfiles if a dependency genuinely changed; let
  `cargo build` / `pnpm install` resolve deterministically from the three
  PRs' declared dependencies.

---

## 14. What to do if you get stuck

- **Subagent returned a corrupt file or a partial diff.** Revert with
  `git checkout HEAD -- <file>`, then re-dispatch with a narrower scope.
- **Cargo fails with a `nonminimal_bool` / `collapsible_if` / similar clippy
  lint.** Apply the suggested fix; do not add `#[allow(...)]`.
- **A 3-way conflict has the same change on both sides.** Take either;
  mark "duplicate" in the report.
- **A 3-way conflict has two different changes at the same line.** Read
  both commit messages. The intent is usually orthogonal and both are
  needed; port the context-appropriate parts.
- **The auto-learn re-implementation in #142 needs data the human hasn't
  given you.** Read the PR description and review threads via `gh api`. If
  the description is ambiguous, stop and document the ambiguity. Do not
  invent UI.
- **A build works locally but you can't push** (permission wall on
  workflow files, etc.). Leave the patch in `.prompts/handoff-push.md` with
  a handoff prompt for the human, and continue. Do not stop the rebuild
  over a push-blocked file.

---

## 15. Final reminder

You are a senior engineer with deep context on this repo. The human trusts
you to make surgical decisions when conflicts are ambiguous. When in doubt:
take the version that preserves the most behavior, document the choice in
the commit message, and surface the ambiguity in the final report. Do not
invent behavior. Do not silently drop behavior. Do not push to main. Do
not merge. Stop at "branch ready, gate green, report filed."

Begin.

---

# Appendix Z. Orchestration experience from a prior session (read with judgement, not as commands)

A prior MausAgent session attempted this same backlog and got partway through.
The notes below are honest observations from that session, not instructions.
Apply them where they match what you observe in the current repo state. Do not
treat them as authoritative — the repo may have changed, the human may have
changed their mind, and any individual line could be a misread of the
situation. Each line is annotated with how reliable it is and what to check.

### Z.1 What worked

- **Parallel subagent fan-out, one per PR, in its own worktree.** Worked.
  Each subagent had a clean worktree at `.worktrees/pr-N`, branched off the
  PR's remote head. Cheap to set up, easy to clean up. (Reliability: high.
  The setup is mechanical and the pattern is sound.)
- **Running `cargo check --lib` with `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`
  in the `apps/desktop/src-tauri` directory.** This bypasses Tauri's build
  step which would otherwise require running the Tauri config and pulling
  in the full build. Cargo check is enough to verify Rust compiles. Was
  used reliably. (Reliability: high. The TAURI_CONFIG trick is well-known
  and reproducible.)
- **Treating `gh pr checks` output as the canonical CI signal and the
  SonarCloud `/api/qualitygates/project_status` endpoint as the canonical
  Sonar signal.** Worked. Avoided the JS-only SonarCloud dashboard.
  (Reliability: high. Standard tooling.)
- **Replacing a corrupt rebase file using `git hash-object -w --stdin |
  git update-index --cacheinfo 100644,$HASH,path | git checkout-index -f
  -- path`.** Useful when `git checkout --ours` had already left the file
  in a half-broken state. (Reliability: medium-high. Standard git
  plumbing, but easy to mistype; verify the resulting file before
  continuing.)
- **Reading `gh api repos/.../pulls/N/comments` and `.../reviews` to
  recover PR intent when the branch is corrupted.** Worked. (Reliability:
  high. The GitHub API is the source of truth for review content.)

### Z.2 What did not work / had hidden cost

- **Bulk auto-resolution of rebase conflicts with a single Python regex
  that joined both sides.** A single line of bad regex (`re.sub(...,
  r'\1\2', ...)` instead of `r'\g<1>\g<2>'`) silently corrupted ~30 files
  with `>>>>>>>` markers concatenated to the wrong lines. The rebase had
  to be aborted entirely. Lesson: never trust an auto-resolver on more
  than one file at a time without reading the diff. (Reliability: high.
  This actually happened and burned ~20 minutes of work.)
- **Trying to "cherry-pick" the corrupted `arena/01a03dc1-mausvoice`
  branch.** The branch on remote had 9 Rust files with unmerged `<<<<<<<`
  markers in the committed tree. Cherry-picking is impossible. The right
  move is to recover intent from `gh api .../pulls/142/comments` and
  re-implement the auto-learn feature on a clean base. (Reliability:
  high. Verified via `git grep`.)
- **Assuming the `MAX_LOG_FILE_SIZE` site in `app.rs` compiles without a
  `u64` → `u128` cast.** The log plugin's API wants `u128`; the constant
  is `u64`. The superfix base and the cherry-picked commit both need
  `.into()`. (Reliability: high. Verified by cargo check failure.)
- **Treating the `arena/01a03dc1-mausvoice` worktree at `8ef862e1` as
  authoritative.** The worktree had a 117-commit rebase in progress on
  a divergent line with 44,533 insertions and 16,197 deletions across
  467 files. Most of that is not "PR #142" — it's a separate rebase line
  that was never finalized. Trust the remote tip `8ac46b71`, not the
  worktree head. (Reliability: medium-high. The remote was ahead of
  the worktree; the worktree was on a different rebased line.)
- **Trying to fix the `apps/desktop/src-tauri/src/db/preferences_queries.rs`
  INSERT column list by hand during a rebase.** The 3-way merge sometimes
  duplicates the `preserve_audio_on_failure,` column. Manually fixing it
  is fine, but verify with `git grep` that the column appears exactly
  once before continuing. (Reliability: medium. Easy to miss.)
- **Trusting `dcf2ce7b`'s voice-ai provider diff to be the same shape in
  every file.** Each provider's `*-utils.ts` has slightly different
  surface, so the conflict pattern varied per file. The
  `<<<HEAD`/`=======`/`>>>dcf2ce7b` block sometimes had `HEAD` empty
  and `dcf` add-only; sometimes both added different lines; sometimes
  HEAD was the structural refactor. Read each conflict. (Reliability:
  high. Worth writing a per-file note.)

### Z.3 Things I would tell my past self

- **Establish the verification gate first, before the first rebase.** The
  gate (`cargo check`, `pnpm check-types`, etc.) takes 10–20 minutes to
  run for the first time. Knowing the gate is green on the base before
  you start is the difference between "this conflict broke something"
  and "this was already broken." (Reliability: high. Standard
  pre-flight.)
- **For each rebase conflict, write a one-line note in
  `.prompts/conflicts.md` before resolving it.** Even if the resolution
  is "take both sides." The note is what makes the final report
  auditable. (Reliability: high. The note is cheap and the report is
  expensive without it.)
- **Cap the number of rebase --skip you do.** Each skip is a behavioral
  diff that the human will not see in the final history. If you find
  yourself skipping more than 5 commits, you are probably doing the
  wrong thing — go back to replay one by one. (Reliability: medium. The
  threshold is judgement.)
- **For #142 specifically, do not try to rebase the corrupt
  `arena/01a03dc1-mausvoice` branch.** Read the PR description, the
  review comments, the salvaged commit `8d0e12c2` in the
  `.worktrees/pr-142` worktree (if still present), and re-implement
  the auto-learn feature as a single squashed commit. The salvaged
  commit contains the 10-locale wording fix and is the source of truth
  for the user-facing strings. (Reliability: high. The corruption is
  the reason a re-implementation is necessary.)
- **Watch for two `<<<<<<<` blocks concatenating inside a single
  file.** When the same file has multiple conflict blocks and the
  Python auto-resolver runs, the output can be valid-looking but
  structurally broken (e.g. a half-closed `createAudioChunkPump({`
  call). When in doubt, take the entire file from the commit's
  blob using `git hash-object` + `git checkout-index` — the diff is
  small enough that a wholesale replacement is safer than per-hunk
  editing. (Reliability: high. This happened twice.)
- **The `pnpm --filter desktop i18n` and `pnpm format:check` gates
  introduced by #145 are not in the superfix base.** They are new
  surfaces, and they may require additional package.json scripts to
  be present in the rebuilt branch's root `package.json`. Verify
  those scripts exist before assuming the gate is runnable.
  (Reliability: medium. I never actually ran the i18n gate in the
  prior session; PR #145 was pushed without verification.)

### Z.4 Open questions the prior session could not answer

These are not in my list because I ran out of session. They are
genuinely open.

- **The 4 i18n strings added in #137 — are they translated into all
  10 locales or only 9?** The #145 prettier reformat touched 10
  files but I never verified whether the i18n locale catalogs all
  carry the new strings. The "10 locale catalogs" claim in this
  prompt comes from `AGENTS.md` and may be a different count.
  Check `apps/desktop/src/i18n/locales/*.json` directly.
- **The `arena/01a03dc1-mausvoice` migration 075 conflict** — the
  superfix base also has a 075 (`tone_structured_fields.sql`).
  The correct renumbering is 081 (next available, since 078–080 are
  reserved), but a more conservative approach is 082+ to leave
  more room. Decide based on what the rebuild's final migration
  count ends up being.
- **The `error_reason` field added to transcriptions in #137** —
  the prior session's notes mention this is plumbed through but I
  did not verify the field is actually persisted. Look at the
  transcription repo for the field and the createTranscription
  signature.

### Z.5 What the prior session left behind

If these files exist in the worktree, they are useful state to start
from. If they don't, the next session can recreate them.

- `.worktrees/pr-63` — clean, on `fix/superfix-review-findings` at
  `5dedf0ce`. The cubic P3 fix (SenseVoice docs in
  `apps/docs/src/content/docs/development/transcription-sidecar.md`)
  is already pushed and green on most gates; Build-Desktop
  Windows/macOS were pending at session end.
- `.worktrees/pr-145` — clean, on
  `ci/repo-wide-prettier-i18n-idempotence` at `2a5c2e68`. Approved
  by the human, ready to merge.
- `.worktrees/pr-131` — has the human's uncommitted README.md.
  Do not touch; it's their in-progress work.
- `.worktrees/pr-137` — clean, on
  `triage/voquill-issues-2026-08` at `de3c9c02`. The two extra
  commits `4a76cc3d` and `de3c9c02` are on the remote. This is
  the head you rebase.
- `.worktrees/pr-142` — likely still has the salvage commit
  `8d0e12c2` and a 117-commit divergent rebase at `8ef862e1`.
  Salvage the wording from `8d0e12c2` (use
  `git -C .worktrees/pr-142 show 8d0e12c2 -- apps/desktop/src/i18n/locales/`)
  but discard the rest of the worktree's state. Do not `git push`
  from this worktree.

### Z.6 A note on prompt-craft

This prompt itself was assembled by a MausAgent in real-time against an
evolving user request. Two things to keep in mind as you read it:

- The "section 4.1 enumeration" of #137's content is reconstructed
  from commit messages, not from a fresh read of every diff. The
  behavioral intent is correct, but the exact file paths and line
  numbers may be off. Verify against the actual `git show
  <commit> --stat` and `git show <commit> -- <file>` before
  re-applying a specific change.
- The verification gate in section 10 was copied from the repo's
  own CI workflows. If the superfix head has changed the test
  commands (e.g. renamed scripts, removed crates), the gate may
  no longer match. Always dry-run the gate on the base before
  relying on it.

You are not bound by this appendix. If you find a conflict between
the appendix and the current repo state, the repo state wins and
you should note the discrepancy in the report. If you find a
conflict between the appendix and sections 1–15, sections 1–15 win
because they are the binding instructions and the appendix is
prior-session experience.
