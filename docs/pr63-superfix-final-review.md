# Reviewed state

Pull request: mausVoice #63, titled "superfixer pre 1.6 realease"
Repository: maus-inc/mausVoice
Base branch: main
Original PR head: fix/superfix-review-findings at 0a34ea4a (the commit this review started from)
Review branch: arena/01a07b8d-mausvoice
Review head: the final commit of this branch, which is this report
Review date: 2026-09-07

This review covered all 172 commits of the PR, every changed file, every
top-level comment, every review, every inline comment and thread including
resolved and outdated ones, the cumulative diff against the base, the
AGENTS.md, REVIEW.md and FULL-REVIEW.md instructions, CI status, and every
direct consumer of the changed contracts. In this pass the review also
re-read the whole diff line by line and verified each new behavior against
upstream documentation: OpenAI, Anthropic, GitHub Actions, TOML, Homebrew
and MDN sources.

The PR's own branch was not modified. All corrective work lives on
arena/01a07b8d-mausvoice, continued from arena/01a07713-mausvoice at
6eec3eea. That branch is 34 commits ahead of the PR head and is submitted
as a corrective pull request against fix/superfix-review-findings. CI on
the review branch uses the same workflows the PR would use because they
trigger on push.

# Change inventory

Relative to the PR head 0a34ea4a, the review branch adds:

- 34 commits
- 55 files changed
- 2368 insertions, 187 deletions

Groups of changes, newest first:

| Commit | Group | What it fixes |
| --- | --- | --- |
| (this report) | Docs | Final review report with post-fix results, including the Secret Scan cache fix and the SonarCloud duplication cleanup. |
| 194e9fee | CI | Action pin list stored as one whitespace table so SonarCloud does not count 3-tuple rows as duplication. collectWorkflowFacts now stops at the next uses: sibling. |
| e52c5930 | Voice AI tests | Shared OpenAI chat mock for Cerebras and Deepseek wrapper tests. The explicit it() bodies stay. |
| 694ab900 | Voice AI tests | Azure deployment coverage uses it.each instead of two copy-pasted it() blocks. |
| a295c5a5 | Desktop tests | One generate-text provider case table shared by the maxTokens and signal suites. |
| 2b796c5e | CI | setup-node v5 fails Secret Scan because that job never installs pnpm. The job now disables the package manager cache, and the pin guard requires every setup-node step to set cache: pnpm or package-manager-cache: false, never both. |
| 2f08b1c2 | Desktop behavior | One shared native pill placement push. The settings toggle and the Windows startup re-apply no longer each keep their own copy of the Tauri call. |
| 54c5f687 | CI | setup-node v5 fails a job that never installs pnpm. The Rust unit job now disables the package manager cache. |
| eb450b3e | CI | The workflow action pins claimed v5 but were v4.4.0 commits that run on Node 20. Re-pinned to verified Node 24 SHAs and added a guard test. |
| 66f0605f | Voice AI | Provider retries were disabled whenever a signal existed. Retries now stay on for transient failures and stop only after a real abort. |
| af8028ac | CI | Bindings regeneration failed on CI because the transcription binaries are never built. The verify step now uses the same externalBin override as the Rust tests. |
| 335a8f76 | CI | The bindings sync check used an invalid git flag and rejected every checkout as untracked before regenerating. Also added the guard test and fixed the workflow trigger paths. |
| 3416022a | CI | The bindings check now prints the full diff on failure so the next failure can be diagnosed from logs. |
| 44dd4362 | Docs | Draft final review report, replaced by this document. |
| 99908bf4 | Docs | README-process change: every diff review must verify new behavior against popular sources. |
| f78bb034 | Voice AI | Six test wrapper files flagged by SonarCloud now carry explicit it() tests. |
| 262acfe8 | Docs | Explains why the Groq client runs with dangerouslyAllowBrowser. |
| 5c94f2f1 | Tooling | Webdriver finds npm under Homebrew on Apple Silicon and Intel. |
| 57ce1653 | Desktop | The saved transcription path is threaded into segment requests instead of being lost. |
| c5401c6b | Desktop | The edit watch is cleared when the side-effect component unmounts. |
| a0a56fdc | Desktop | Windows resume re-registers the keyboard hook and re-applies pill placement. |
| 4947759c | Desktop | AbortSignal is forwarded through every generate-text repo, not just Groq. |
| 32bb7cee | Voice AI | Generate calls accept an AbortSignal in all providers. |
| df92ccaa | Voice AI | Secrets are redacted from Cerebras provider errors. |
| 28d07dc5 | Desktop | Post-processing is bounded by an abortable 50 second timeout. |
| 0cff31a9 | Desktop | Deleting a conversation aborts its agent loop. |
| c6c7ea5b | Tauri | Stale clippy allows removed from encoding utilities. |
| 33904eab | Tauri | Unused Windows feature removed from Cargo.toml. |
| 3fedaa04 | CI | The gitleaks config guard parses useDefault outside TOML strings. |
| 332304cd | Bindings | Regenerated bindings for the interaction feedback commands. |
| a11b570e | CI | New CI step verifying generated bindings stay in sync. |
| 91c8cfd5 | CI | Actions pinned to commit SHAs, later corrected by eb450b3e. |

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

Commit: 66f0605f

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

Commit: 335a8f76

### 3. Bindings regeneration could not run on CI

With the guard fixed, the generator reached cargo and failed because
tauri's build script demands the transcription binaries, which are
git-ignored and never built on the runner:

resource path binaries/rust-transcription-cpu-x86_64-unknown-linux-gnu
does not exist

The cargo test step already worked around this with TAURI_CONFIG
externalBin empty. The verify step never set it.

Fix: same override on the verify step, pinned by the guard test.

Commit: af8028ac

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
package-manager-cache: false. Every other job that installs pnpm passes
cache: pnpm explicitly.

Fix: all pins re-resolved through the GitHub API and each action.yml
runtime confirmed. Added scripts/ci/check-workflow-pins.test.mjs, which
fails on floating tags, unknown SHAs, node20 pins and wrong comments.

Commits: eb450b3e, 54c5f687

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

Commit: 2f08b1c2

### 6. Secret Scan failed on setup-node's default package-manager cache

After the Node 24 pin bump, Secret Scan failed at Setup Node on run
34111948547 (and the previous head 076c28b, run 34110505847). The job
pins setup-node v5 with node-version-file: .nvmrc and no cache config.
v5 defaults package-manager-cache to true, which runs the detected
package manager to prime the cache. This job never installs pnpm, so
the step errors.

The Rust unit job already opted out with package-manager-cache: false.
Secret Scan now does the same. The pin guard was extended so every
setup-node step must set exactly one of cache: pnpm or
package-manager-cache: false. The pin table was re-keyed by short action
name and the two scanners were merged into collectWorkflowFacts so the
new cache check does not create its own duplication.

Commit: 2b796c5a

### 7. SonarCloud Quality Gate failed on new-code duplication

PR analysis on head 6eec3eea reported 9.9 percent duplication on new
code (limit 3 percent): 193 duplicated lines in 7 blocks.

- generate-text.repo.test.ts declared the same 9-provider table twice.
- azure-openai.utils.test.ts had two it() blocks that differed only in
  deployment name and response_format.
- cerebras.utils.test.ts and deepseek.utils.test.ts copied the
  afterEach reset and mockCreate helper.
- check-workflow-pins.test.mjs repeated a { version, runtime } row
  shape in VERIFIED_PINS, then a 3-tuple row shape after the first
  restructure.

Fixes keep every explicit it() in the wrapper files. The generate-text
suites share one providerCases table. Azure uses it.each. Cerebras and
Deepseek import mockOpenAIChatCreate from the existing helper. The pin
list is one whitespace table parsed into a map.

Commits: a295c5a5, 694ab900, e52c5930, 2b796c5e, 194e9fee

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
- The workflow pin table: SHA, Node runtime, version comment, and the
  setup-node cache contract (cache: pnpm xor package-manager-cache:
  false).
- setPillPlacement persistence and native push, including failure.
- Explicit it() tests in the six Sonar-flagged wrapper files.
- The 31-case generate-text repo suite including per-provider signal
  forwarding and the Groq no-fallback-on-abort path.

Numbers at the review head: 112 desktop test files and 1185 tests, 18
voice-ai test files and 148 tests, all passing locally.

Coverage percentage could not be measured in the review environment.
The coverage provider is not installed in the sandbox and vitest
--coverage fails at packages/voice-ai. SonarCloud measures new-code
coverage on the opened pull request.

# Verification performed

Local:

- pnpm --filter desktop check-types: clean
- pnpm --filter desktop lint: clean in CI (Lint Desktop)
- pnpm --filter desktop test:unit: 112 files, 1185 tests passed
- pnpm --filter @maus-inc/voice-ai test: 18 files, 148 tests passed
- pnpm --filter @maus-inc/voice-ai build: clean
- npm run format:check: all matched files clean
- Both CI guard tests run locally, including the new setup-node cache
  contract

CI on the review branch at earlier heads (05e64c5, 039c4a6, 411a652)
was green for Test Desktop Unit, Test Desktop Integration, Lint Desktop,
Build Desktop (Windows, Linux, macOS), Test Docs and Test Package Rust
Transcription. Head 6eec3eea had Secret Scan red (the cache defect
above) and SonarCloud duplication above the gate. Those two are fixed
on this head. Every workflow must be re-confirmed green on the pushed
head before merge.

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
- Every setup-node step either caches pnpm or disables
  package-manager-cache. Secret Scan and the Rust unit job take the
  disable path because they never install pnpm.

# Assumptions and unknowns

- Windows manual QA was not performed. The mandate requires it first, and
  the review sandbox cannot run Windows, the native pill, or the
  installed transcription sidecar. This is the biggest remaining
  unknown and it is the reason for the conditional verdict.
- SonarCloud analysis runs on the opened pull request. Zero new issues
  and a passing quality gate at the head still need to be confirmed after
  the review bots finish, along with review bot comments.
- The release workflow needs a tag event or manual dispatch, so the
  upload-artifact v6 and action-gh-release v3 pins are verified by source
  and guard test only, not by a real run.
- The TOML quoted-key limitation above is accepted as out of scope.

# Release recommendation

CONDITIONAL GO

Conditions before release:

1. Run the mandated Windows manual Qve is accepted as out of scope.

# Release recommendation

CONDITIONAL GO

Conditions before release:

1. Run the mandated Windows manual QA: fresh and existing profiles,
   restarts, all windows and the pill, 100/125/150/200 percent DPI,
   multi-monitor, offline and slow network, provider failure modes, style
   change during dictation, rapid pill clicks, the review-before-insert
   lifecycle including failure, assistant Markdown and tool calls, import,
   retranscription and history.
2. The pull request from arena/01a07b8d-mausvoice is open against
   fix/superfix-review-findings. Let review bots and SonarCloud run, and
   drive them to zero new issues and zero open review threads before
   merging.
3. Confirm every workflow is green on the final head: Secret Scan,
   Format and i18n, Test Desktop Unit (including the guard tests), Test
   Desktop Integration, Lint Desktop, Build Desktop on Windows, Linux and
   macOS, Test Docs, and Test Package Rust Transcription.
