# Reviewed state

Pull request: mausVoice #63, titled "superfixer pre 1.6 realease"
Repository: maus-inc/mausVoice
Base branch: main
Original PR head: fix/superfix-review-findings at 0a34ea4a (the commit this review started from)
Review branch: arena/01a07713-mausvoice
Review head: 039c4a6
Review date: 2026-09-06

This review covered all 172 commits of the PR, every changed file, every
top-level comment, every review, every inline comment and thread including
resolved and outdated ones, the cumulative diff against the base, the
AGENTS.md, REVIEW.md and FULL-REVIEW.md instructions, CI status, and every
direct consumer of the changed contracts. In this pass the review also
re-read the whole diff line by line and verified each new behavior against
upstream documentation: OpenAI, Anthropic, GitHub Actions, TOML, Homebrew
and MDN sources.

The PR's own branch was not modified. All corrective work lives on
arena/01a07713-mausvoice. That branch is 28 commits ahead of the PR head
and has no pull request yet. CI on the review branch uses the same
workflows the PR would use because they trigger on push.

# Change inventory

Relative to the PR head 0a34ea4a, the review branch adds:

- 28 commits
- 57 files changed
- 2358 insertions, 124 deletions

The review branch also carries 6 upstream main commits that arrived
through a merge and are not review output. They are listed only to explain
the commit count.

Groups of changes, newest first:

| Commit | Group | What it fixes |
| --- | --- | --- |
| 039c4a6 | Desktop behavior | One shared native pill placement push. The settings toggle and the Windows startup re-apply no longer each keep their own copy of the Tauri call. |
| 05e64c5 | CI | setup-node v5 fails a job that never installs pnpm. The Rust unit job now disables the package manager cache. |
| 411a652 | CI | The workflow action pins claimed v5 but were v4.4.0 commits that run on Node 20. Re-pinned to verified Node 24 SHAs and added a guard test. |
| 006ea81 | Voice AI | Provider retries were disabled whenever a signal existed. Retries now stay on for transient failures and stop only after a real abort. |
| 5063915 | CI | Bindings regeneration failed on CI because the transcription binaries are never built. The verify step now uses the same externalBin override as the Rust tests. |
| 07cb933 | CI | The bindings sync check used an invalid git flag and rejected every checkout as untracked before regenerating. Also added the guard test and fixed the workflow trigger paths. |
| 05091a5 | CI | The bindings check now prints the full diff on failure so the next failure can be diagnosed from logs. |
| 9850b29 | Docs | Draft final review report, replaced by this document. |
| a519560 | Docs | README-process change: every diff review must verify new behavior against popular sources. |
| 63b539e | Voice AI | Six test wrapper files flagged by SonarCloud now carry explicit it() tests. |
| 8e46fe2 | Docs | Explains why the Groq client runs with dangerouslyAllowBrowser. |
| 9c1100f | Tooling | Webdriver finds npm under Homebrew on Apple Silicon and Intel. |
| 31124b1 | Desktop | The saved transcription path is threaded into segment requests instead of being lost. |
| 7eb2ce3 | Desktop | The edit watch is cleared when the side-effect component unmounts. |
| f4a1f0d | Desktop | Windows resume re-registers the keyboard hook and re-applies pill placement. |
| b0ab801 | Desktop | AbortSignal is forwarded through every generate-text repo, not just Groq. |
| d9aa5f2 | Voice AI | Generate calls accept an AbortSignal in all providers. |
| d307e66 | Voice AI | Secrets are redacted from Cerebras provider errors. |
| 6e6a2d1 | Desktop | Post-processing is bounded by an abortable 50 second timeout. |
| 87cc477 | Desktop | Deleting a conversation aborts its agent loop. |
| 0141273 | Tauri | Stale clippy allows removed from encoding utilities. |
| 1fab2dd | Tauri | Unused Windows feature removed from Cargo.toml. |
| 2c2aa14 | CI | The gitleaks config guard parses useDefault outside TOML strings. |
| e7e6850 | Docs | Prettier applied to the root README. |
| 555f790 | Bindings | Regenerated bindings for the interaction feedback commands. |
| 276b475 | CI | New CI step verifying generated bindings stay in sync. |
| 0793028 | CI | Actions pinned to commit SHAs, later corrected by 411a652. |

# Findings

All findings below were confirmed, meaning I reproduced or verified them
from primary sources. None are speculative. Each fix has a regression
test and its own commit, except where the finding is documentation only.

## Confirmed defects, fixed

### 1. Provider retries disappeared when any signal was passed

The generate-signal change set retries to signal ? 1 : 3 in seven
providers. Callers always pass a signal. The post-processing deadline
does, and every generate-text repo now forwards one. So a transient
network failure or 5xx during transcript cleanup failed after one
attempt, which is a regression against the old retry contract.

Verified against openai-node and anthropic-sdk sources. Both SDKs throw
an abort error only when options.signal.aborted is true. A present but
not aborted signal is not an abort. SDKs never retry internally on abort
either.

Fix: retries stay at 3 in all providers. Retryability is gated on the
signal's aborted state: isRetryable: (error) => !signal?.aborted.
Cerebras keeps its terminal status gate too.

Regression tests: a transient failure is retried when a signal is
present but not aborted, and an aborted signal stops after one attempt.
Covered through the shared OpenAI-compatible helper, the shared Anthropic
helper and the Groq suite.

Commit: 006ea81

### 2. The bindings sync check was broken, not the bindings

The Desktop Rust Unit job failed on "Verify generated bindings are in
sync" with this message: bindings.ts is not tracked by git.

The file has been tracked forever. The guard called git ls-files
--error-unmatched, which is not a git option. The correct flag is
--error-unmatch. Git exits with a usage error, the guard inverted the
failure, and every checkout was rejected as untracked before the
generator ever ran.

So the earlier hypothesis that hand-written bindings mismatched the
generator output was wrong. The check never compared anything.

Fix: correct flag, guard test, and the workflow now triggers when the
guard scripts change.

Commit: 07cb933

### 3. Bindings regeneration could not run on CI

With the guard fixed, the generator reached cargo and failed because
tauri's build script demands the transcription binaries, which are
git-ignored and never built on the runner:

resource path binaries/rust-transcription-cpu-x86_64-unknown-linux-gnu
does not exist

The cargo test step already worked around this with TAURI_CONFIG
externalBin empty. The verify step never set it.

Fix: same override on the verify step, pinned by the guard test.

Commit: 5063915

### 4. Action pins claimed v5 but were v4 on Node 20

Commit 0793028 said it pinned checkout and setup-node at v5. Both SHAs
resolve to v4.4.0 and declare runs.using: node20. The comments label
them v5. The same mislabel hit upload-artifact, and release.yml still
pinned node20 versions of pnpm/action-setup and action-gh-release.

The stated reason for avoiding v5 was that it might break CI. That is
inverted. v5 is the Node 24 runtime bump. The repo's main branch runs
@v5 and is green. GitHub removes Node 20 from runners on 2026-09-16,
which is ten days after this review. The v4 pins are the ones that break.

The one real v5 change is that setup-node limits automatic caching to
npm and defaults package-manager-cache to on. It errored on the Rust unit
job because that job never installs pnpm. Fixed with
package-manager-cache: false. Every other job passes cache: pnpm
explicitly, so they are unaffected.

Fix: all pins re-resolved through the GitHub API and each action.yml
runtime confirmed. Added scripts/ci/check-workflow-pins.test.mjs, which
fails on floating tags, unknown SHAs, node20 pins and wrong comments.

Commits: 411a652, 05e64c5

### 5. Two copies of the native pill placement push

The Windows resume work added pushPillPlacementToNative. The settings
toggle already persisted the preference and pushed it to native with the
same invoke and the same warning text. Two implementations meant the
native call could drift.

Fix: one native push lives in windows-sync.actions.ts and is used by both
the settings toggle and the startup re-apply. The shared helper is typed
with PillPlacement from @maus-inc/types instead of an inline union.

Regression tests: the preference persists and the placement is pushed;
the preference survives a native rejection and the warning logs once.

Commit: 039c4a6

## Confirmed findings from the PR's own history that were already handled in the review branch before this pass

These were found in the earlier review passes and their fixes are on the
branch: the Windows keyboard hook resurrection, the edit watch leak, the
lost transcription path, the un-aborted agent loop, post-processing
without a deadline, and the SonarCloud wrapper files. All have tests and
are included in the change inventory above.

## Observations, not confirmed defects

- composer.actions.ts line 12 calls generateText without a signal. The
  file is unchanged against the PR base and the edit-mode flow never had
  a cancel path, so this is not a regression introduced by the PR. It is
  a product decision to make in a follow-up: should Edit Mode be
  cancellable.
- The gitleaks config guard scans for a bare key named useDefault outside
  strings. A quoted key, "useDefault" = false, would not be seen by the
  scanner. The previous regex check missed that case too, so this is not
  a new regression, and no repository file uses quoted keys. Recorded as
  a known limitation.

# Missing test coverage

Coverage added by this review branch:

- Provider retry behavior per provider family: present signal keeps
  retries, aborted signal stops after one attempt.
- The bindings guard semantics and the CI env required for regeneration.
- The workflow pin table: SHA, Node runtime and version comment.
- setPillPlacement persistence and native push, including failure.
- Explicit it() tests in the six Sonar-flagged wrapper files.
- The 31-case generate-text repo suite including per-provider signal
  forwarding and the Groq no-fallback-on-abort path.

Numbers at the review head: 112 desktop test files and 1185 tests, 18
voice-ai test files and 148 tests, all passing locally.

Coverage percentage could not be measured in the review environment.
The coverage provider is not installed in the sandbox and vitest
--coverage fails at packages/voice-ai. SonarCloud will measure new-code
coverage once a pull request exists.

# Verification performed

Local:

- pnpm --filter desktop check-types: clean
- pnpm --filter desktop lint: clean in CI (Lint Desktop)
- pnpm --filter desktop test:unit: 112 files, 1185 tests passed
- pnpm --filter @maus-inc/voice-ai test: 18 files, 148 tests passed
- pnpm --filter @maus-inc/voice-ai build: clean
- npm run format:check: all matched files clean
- Both CI guard tests run locally and in the workflow

CI on the review branch, head 039c4a6:

- Test Desktop Unit: passed (includes Rust unit tests, bindings sync,
  both guard tests)
- Test Desktop Integration: passed
- Lint Desktop: passed
- Build Desktop: was still running at the time of writing
- Test Docs, Test Package Rust Transcription: passed on the pin change
  commit 411a652

The release workflow is manual only, so it could not be exercised
without a release. This is an environment limitation, not a skipped
check.

# Correct behavior confirmed

- The committed bindings.ts matches the generator output. CI regenerates
  and diffs on every run and the step is green.
- Provider abort semantics match the SDK contract: an aborted signal is
  terminal, a present signal is not.
- The post-processing timeout at 50 seconds sits inside the outer 60
  second dictation budget, so the inner abort fires first.
- The desktop_resume event name matches the Rust constant
  EVT_DESKTOP_RESUME, and the frontend gates the restart on listener
  strategy, main window and accessibility permission.
- The Homebrew npm paths match what Homebrew installs on both Apple
  Silicon and Intel.
- Promise.race inside withTimeout marks the losing promise as handled, so
  a late rejection cannot surface as an unhandled rejection.
- Every workflow action is pinned to a commit SHA whose action.yml
  declares node24 or composite, verified through the GitHub API and
  enforced by the new guard test.

# Assumptions and unknowns

- Windows manual QA was not performed. The mandate requires it first, and
  the review sandbox cannot run Windows, the native pill, or the
  installed transcription sidecar. This is the biggest remaining
  unknown and it is the reason for the conditional verdict.
- SonarCloud analysis only runs on a pull request. Zero new issues and
  zero accepted issues at the PR head still need to be verified after the
  PR is opened, along with review bot comments.
- The release workflow needs a tag event or manual dispatch, so the
  upload-artifact v6 and action-gh-release v3 pins are verified by source
  and guard test only, not by a real run.
- The TOML quoted-key limitation above is accepted as out of scope.

# Release recommendation

CONDITIONAL GO

Conditions before release:

1. Run the mandated Windows manual QA: fresh and existing profiles,
   restarts, all windows and the pill, 100/125/150/200 percent DPI,
   multi-monitor, offline and slow network, provider failure modes, style
   change during dictation, rapid pill clicks, the review-before-insert
   lifecycle including failure, assistant Markdown and tool calls, import,
   retranscription and history.
2. Open the pull request from arena/01a07713-mausvoice, let review bots
   and SonarCloud run, and drive them to zero new issues and zero open
   review threads before merging.
3. Confirm Build Desktop finishes green on the final head.
