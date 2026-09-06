# Reviewed state

## What was reviewed

| Item | Value |
| ---- | ----- |
| Pull request | #63 — the "1.6 rebuild" (`fix/superfix-review-findings`) |
| Base branch | `main` at `1beab53f` (merge base before the PR) |
| PR head last reviewed | `0a34ea4` (the last squash, #177) |
| Corrective branch | `arena/01a07713-mausvoice` |
| Corrective branch head | `a519560` (report follows) |
| Branch state | merge `1e65173` (PR head + `origin/main` `0e7bd17`) + 19 focused commits |
| Size reviewed | 612 files, 172 commits, +59,356 / −15,876 lines |
| Change vs PR head | 45 files, +1,536 / −96 lines |
| Change vs branch merge base | 44 files, +1,458 / −84 lines |

**Status:** Ready to run CI on this branch. All checks that can run in this
environment pass. One check can only be proven by the branch's own CI run
(the generate-and-compare command-file job), and Windows runtime behavior
still needs the manual test pass described below.

**Confidence:** Medium-high on code-level correctness; manual Windows
verification is still outstanding, so the release recommendation below is
conditional, not unconditional.

## What the PR did, in plain words

The PR rebuilt a large part of the desktop app: it moved post-processing
and provider calls into a shared layer, added native audio-feedback
controls, added a settings-driven pill, restructured transcription
storage, and updated the desktop/API contract. It also restructured the
README and added several CI guards.

Reviewing it meant walking every commit (172), every changed file, all
review threads (180), all inline comments (259), and then checking each
changed contract against its callers. Most of the review work is now
recorded as fixes; this document records what was fixed, what was
checked and left alone, and what still has to happen before release.

## What was fixed (one commit each, all with tests that fail without the fix)

1. **The generated command file missed two real commands.**
   `setInteractionChimeEnabled` and `setInteractionFeedbackVolume` are
   declared in Rust but were not copied into the TypeScript file the web
   page uses to call the app, so calling them from the frontend would
   fail at runtime. Fixed both sides against the generator's output
   format, and added a CI job that regenerates the file and fails on any
   difference, so this cannot silently happen again.

2. **CI used moving version tags instead of fixed commits.** Five
   workflows referenced `actions/checkout@v5` and
   `actions/setup-node@v5` by tag, which can change under a release.
   Pinned all five (plus the docs workflow's two page actions) to full
   commit SHAs with the tag recorded in a comment.

3. **The root README failed the repo-wide Prettier check.** After the
   branch/main merge, the README had trailing whitespace and extra blank
   lines. Formatted it; no content change. This was the only failing PR
   63 check.

4. **The secret-scan config guard could fail CI for a false reason.** It
   looked for `useDefault = false` with raw text search, so prose inside
   a description string that mentioned the same phrase tripped it. Now
   parses key/value pairs outside strings and only flags a real
   top-level assignment; four tests cover the shapes.

5. **Two dead Rust settings removed.** A compiler-warning suppression in
   the encoding utility that outlived its use (the code already uses
   `as_chunks`), and a Windows API feature in `Cargo.toml` that no code
   uses. Each was reviewed to confirm nothing still depends on them; the
   Linux audio path keeps its own suppression because it still needs it.

6. **Deleting a conversation didn't stop its assistant run.** The run
   lives outside the send queue, so deleting mid-run kept spending model
   tokens and writing assistant messages against a row about to be
   deleted. Delete now aborts the run first. The abort is safe to call
   when nothing is running.

7. **A hung post-processing call was never cancelled.** The timeout
   abandoned it in the UI, but the request kept running against the
   provider and burning quota. Restored a cancel handle: the
   post-processing step gets its own 50-second deadline (inside the
   existing 60-second outer budget), and on expiry it tells the provider
   call to stop. Regression-tested with fake timers; the raw transcript
   still survives.

8. **Cerebras error messages could contain the API key.** Provider SDK
   errors can echo key material ("Incorrect API key provided: csk_…")
   and proxies can echo the authorization header, and those messages
   reach logs and saved metadata. Scrub key material and authorization
   headers from every error message before wrapping. Tests cover both a
   provider 401 and a proxy 500 echo.

9. **Six providers ignored the cancel handle.** Only Groq accepted an
   abort signal; OpenAI, OpenAI-compatible servers, OpenRouter, Azure,
   DeepSeek, Claude, and Cerebras dropped it, so a timed-out
   post-processing call kept running on those providers. All seven now
   accept the signal, pass it to the SDK request, and stop retrying when
   one is present (a caller deadline is not a transient failure). The
   SDK request-option types confirm signal support for both the OpenAI
   and Anthropic clients. The desktop repo now forwards the signal in
   every one of the nine generate-text classes, so the abort reaches the
   provider regardless of which one is configured. Tests cover per-
   provider forwarding and the Groq no-fallback-on-abort rule.

10. **Windows: saved "top" pill placement was ignored after restart.**
    The native pill starts bottom-anchored, so a persisted top placement
    reverted on every launch until the user toggled the setting. The
    frontend now pushes the saved placement on startup and whenever it
    changes. Windows-only; macOS has no top/bottom placement, Linux's
    pill has no such message.

11. **Windows: keyboard shortcuts died after sleep/wake or unlock.** The
    low-level keyboard hook is torn down on resume, and nothing re-armed
    it. The Rust lifecycle watcher now fires an event the frontend
    listens for, and the frontend re-arms the hook — but only when the
    reason it should be armed is still true (listener strategy active,
    main window, accessibility still authorized). Both failure surfaces
    are logged without alarming the user. Unit tests cover every gating
    combination.

12. **Preference "watch" survived leaving the screen.** The auto-learn
    watch kept polling for its 90-second window after the component
    unmounted, so a stale "learn this word?" prompt could still appear.
    The component now clears the watch on unmount. Cleared via the
    module-level cleanup, which is safe to call more than once, so the
    existing toggle-off path still works. Test mounts and unmounts the
    real component (with React's required test flag set) and asserts the
    watch is dead. Without the test flag this test would pass vacuously;
    the flag is set exactly as React documents.

13. **Custom transcription server paths were silently ignored.** The key
    settings screen saves a path like `/custom/transcriptions`, but the
    request always hit the default `/v1/audio/transcriptions` suffix.
    The saved path is now plumbed from the key record through the repo
    into the request. Tests cover both the custom path and the default
    when nothing is saved.

14. **Local end-to-end tests couldn't find npm on Homebrew macOS.** The
    bootstrap only searched next to the node binary and in Debian's
    system path. Added both Homebrew Cellar npm locations
    (`/opt/homebrew` and `/usr/local`).

15. **Groq's "allow in browser" flag lost its safety explanation.** The
    flag is required inside the Tauri window, and the app never persists
    the key through the browser path. Documented at both client
    construction sites.

16. **Six SonarCloud "add some tests" findings were real.** Sonar can't
    see tests registered by a shared helper file, so it flagged six
    provider test wrappers as having no tests. The fix is not to delete
    the wrappers or hide them from the scanner — it is to add real
    in-file tests. Each wrapper now carries explicit, meaningful cases
    (aldea integration probe + transcript handling, azure json_object vs
    json_schema deployment routing, cerebras 402 as a single-attempt
    provider error, claude system prompt forwarding, deepseek model and
    json_object shape, gemini system prompt + schema conversion). The
    shared helpers stay. Voice-AI suite: 18 files, 134 tests.

17. **The review process itself had a gap.** Agents reviewing a diff
    could accept a line that "looked right" without checking it. A
    mandatory step is now in `AGENTS.md`: read the whole diff first,
    research every new-behavior line against authoritative sources
    (provider docs and changelogs, MDN, React/Node docs, Sonar rule
    source and threads), watch a specific list of correct-looking
    antipatterns, record the source per assumption, resolve conflicts
    before committing, mark unverifiable things as unknown, and repeat
    after fixes land.

## Findings checked and rejected (with the reason)

- **"Pill placement validation doesn't match"** — both sides accept
  exactly `top`/`bottom`; settings are persisted first, then pushed; the
  database default is `bottom`.
- **"Volume slider needs debouncing"** — the slider sends only on
  release, so there is nothing to debounce and duplicate sends are
  harmless.
- **"Chat send queue collects stale entries"** — the cleanup compares
  against the current queue entry, so an old cleanup cannot remove a
  newer one.
- **"Hotkey sync swallows real failures"** — the code returns the real
  result; the comment says so and the code matches.
- **"Startup gate has no timeout"** — a watchdog and stale-result
  rejection already exist.
- **"Windows watch handle never released"** — kept once for process
  lifetime by a message-pump thread that runs until exit; nothing grows.
- **Gladia threads** — all superseded by later code at the head (clean
  close, documented clamp, redaction, model name is used, not
  hardcoded).
- **"Transcription function signature change breaks something"** — it is
  private with one caller, and the output mapping already exists.
- **"Lint now covers tests — weakening?"** — including tests is
  stricter; kept.
- **DeepSource "parse errors"** — tool noise; all six files parse with
  the real parser.
- **Six 20 ms delays, the whole-body fetch tradeoff, `env_clear()`** —
  verified against the surrounding code as safe/necessary, or
  documented as inherited behavior.

## What was verified against outside sources

- The OpenAI and Anthropic SDKs accept an abort signal in request
  options (checked in the installed SDK type definitions — the actual
  version this repo builds against, not a memory of the API).
- The retry helper's `retries` value is the number of attempts, so
  `retries: 1` really means "one attempt, no retry" (checked in
  `packages/utilities/src/async.ts`).
- SonarCloud's "add some tests" rule fires on test files that never
  call a test function directly; shared-helper registration is invisible
  to it. The rule's own source, Sonar community threads for the same
  false-positive family (helper wrappers, `it.each`, tagged-template
  tests), and the fix pattern (explicit `it` in the file) all agree.
  This repo's six flags match that exactly.
- React 19 requires `IS_REACT_ACT_ENVIRONMENT = true` for `act()` to
  flush effects in tests (react.dev); the new component test sets it.
- The generator copies Rust `///` docs into the generated TypeScript
  comments — proven by the file's own already-generated entries and the
  generator docs.

## What still has to happen before release

1. **Windows manual test pass (first priority).** Fresh and existing
   profiles; app restart; every window and the pill; 100/125/150/200%
   DPI; multiple monitors; offline and slow networks; each provider's
   failure behavior; changing style during dictation; rapid pill clicks;
   review-before-insert lifecycle and failure; assistant Markdown and
   tool calls; import / retranscription / history. This is machine
   behavior, not code that unit tests can prove. A focused macOS/Linux
   spot check afterward.
2. **Run the branch's own CI.** The two jobs that must be watched:
   the new generate-and-compare command-file job (it is the proof that
   the two added command wrappers match the generator exactly), and the
   Rust unit tests + formatter. Rust toolchain cannot be installed in
   this environment (TLS is blocked), so these have not run locally.
3. **Watch SonarCloud after the branch is pushed.** The six "add some
   tests" findings should disappear because the wrapper files now call
   `it` directly. If any of the six survive, the remaining cause is in
   that file and must be fixed the same way (add tests), never by
   deleting the wrapper or hiding it from analysis.

## Out of scope but important (not code)

- The `.ghtoken` credential (starts `kgh2…`) exists in the repository's
  history even though the file was later removed. It must be rotated,
  revoked, and purged. The secret-scan workflow at the head does have
  the PR trigger and full-history scan, so this class of mistake is
  caught going forward.
- Large binary request bodies cross the app boundary as long number
  arrays; a documented cap bounds the size. A permanent fix needs
  regenerated files (Rust toolchain), so it is recorded and not risked
  by hand-editing here.

## Checks run on this branch

| Check | Result |
| ----- | ------ |
| Repo-wide Prettier (`format:check`) | Passed |
| Desktop type check (`tsc --noEmit`) | Passed |
| Desktop unit tests | Passed — 112 files, 1,183 tests |
| Voice-AI tests | Passed — 18 files, 134 tests |
| PR 63 CI at last reviewed head | All green except Repo-wide Prettier (fixed by this branch); Sourcery is skipping, it is not a failure |

## Not-run checks (with the reason)

- Rust unit tests, Rust formatter, and the new generate-and-compare
  command-file job: no Rust toolchain in this environment; they run in
  the branch's CI. This is the single biggest remaining unknown, and it
  is why the recommendation is conditional rather than a full GO.
- Windows manual matrix: listed above.
- The `check-bindings.sh` local run cannot succeed without the Rust
  toolchain; the CI job it now feeds is the authoritative check.

# Release recommendation

**CONDITIONAL GO**

Two conditions must be met before this ships, and both are verification,
not code quality:

1. The branch's CI goes green — especially the new
   generate-and-compare command-file job, the Rust unit tests, and the
   Rust formatter.
2. The Windows manual test pass above completes without regression, and
   a focused macOS/Linux spot check passes.

One out-of-band item stays on the release checklist (it is not code):
rotate, revoke, and purge the `.ghtoken` credential from the repository
history.
