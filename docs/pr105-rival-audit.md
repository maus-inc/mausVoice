# Rival Agent Audit — PR #105 ("Superfix: Complete Wave 4")

**Auditor posture:** CodeRabbit ASSERTIVE profile (from `REVIEW.md` §1.1) — correctness, security, edge cases, leaks, concurrency over style; "if a state is physically reachable, it will be reached"; findings carry severity + `File:Line` + *why* + remediation.
**Scope:** full diff of `arena/01a01a61-mausvoice` (`b6ae729`) against `main` (`ff88158`), with emphasis on the *new* Wave-4 work (commits `1cc6a2b..b6ae729`, ~126 files / +4712 −1931).
**Evidence base:** `docs/ui-behavioral-issues-plan.md` agent specs (A04/A11/A12/A19/A21/A23), the implementation files, their tests, `gh pr checks 105`, and `docs/HANDOFF.md`.

---

## Verdict: **Not Ready**

Confidence: **High** · Mergeable: **No** · CI Verification: **Failing** (checks currently `pending`; a prior run hit the Ubuntu Rust-transcription 20-min timeout, documented in `docs/HANDOFF.md`).

The PR ships real, well-hardened Rust work, but the *headline Wave-4 deliverables* are either broken at runtime (A11), never wired in (A19 humanize skill), or regress an explicitly-protected behavior (A21 vs. A09). A right-click on any text input in the app throws an uncaught `TypeError`. These are not style issues — they are functional regressions in the exact features this PR claims to complete.

---

## Major findings

### [Critical — A11] Right-click on any text input throws `TypeError` and suppresses the menu
`apps/desktop/src/components/common/ContextMenu.tsx:513` (and `:361`, `:323`)

*The Problem:* `ContextMenuProvider` registers a **native** listener:
```ts
document.addEventListener("contextmenu", handleGlobalContextMenu);   // :553
// :513  →  ctxMenu.handleContextMenu(e as unknown as React.MouseEvent, [...])
```
`e` here is a native `MouseEvent`. `handleContextMenu` then reads `e.nativeEvent` (`:361`) — a property that exists only on React synthetic events, so it is `undefined` — and passes it to `computePosition`, which dereferences `e.clientX` (`:323`). Result: an **uncaught `TypeError: Cannot read properties of undefined (reading 'clientX')`** on every right-click of an `<input>`, `<textarea>`, or `contenteditable`. Because `e.preventDefault()` (`:511`) runs *before* the throw, the native webview menu is suppressed **and** the custom menu never renders — right-click on the composer, settings fields, search, dictionary inputs, etc. produces no menu and a thrown error. `ContextMenuProvider` is mounted at `Root.tsx:52` *outside* the `ErrorBoundary`, and the throw happens in a DOM listener (not a React render), so nothing catches it.

*The Solution:* Pass the native event through unchanged — `computePosition(e, …)` — or, better, have `handleContextMenu` accept the already-native event instead of assuming a React synthetic wrapper. Add a component test that dispatches a real `contextmenu` DOM event and asserts no throw.

### [Major — A19] The "humanize skill" prompt artifact is dead — never loaded into any pipeline
`scripts/prompts/humanize.txt` (52 lines, added) vs. its zero consumers

*The Problem:* A19's core deliverable #2 is *"a first-class humanize skill loaded into the agent/post-processing pipeline … ONE shared artifact; every pipeline loads it from the same place."* `grep -rni humanize` across the whole repo finds **only** `humanizeScrub` (the post-hoc safety net) called at `run-agent.ts:272`. `humanize.txt` is referenced **nowhere**: not in `packages/agent` (agent-loop), not in `apps/desktop/src/agents/agent-configs.ts`, not in the post-processing prompt assembly, and not even in `scripts/prompts.py` (the existing `polished.txt` regression harness). The prompt artifact is orphaned — the model is never instructed to avoid slop at generation time.

*The Solution:* Wire the skill text into the agent system prompt and the AI post-processing prompt assembly through a single shared loader function, and extend `scripts/prompts.py` (the `polished.txt` precedent) so the artifact is covered by the prompt-regression harness. The PR body's claim that A19 "add[s] a humanize skill" overstates what actually landed.

### [Major — A21] Left/Right style switching while holding the dictate key is broken after the first switch
`apps/desktop/src/utils/hotkey-filter.utils.ts:100-108`, `:116-127` · `apps/desktop/src/components/root/AppSideEffects.tsx:382`

*The Problem:* A21's spec explicitly requires *"Preserve: Left/Right style switching while holding the dictate key (A09's behavior)."* The filter marks a style action "held" after its first fire while recording (`heldActions.add(actionName)`, `:108`) and only releases it via `releaseHotkey("__all__")` — which the wiring calls **only** when `keys_held` becomes empty (`AppSideEffects.tsx:382`, `existing.length > 0 && payload.keys.length === 0`). During hold-to-talk dictation the dictate key stays down, so `keys_held` never empties; the per-action `releaseHotkey(actionName)` branch is **never called in production** (only in the unit test). Consequence: while recording, the *first* Left/Right style switch fires, and every subsequent switch is dropped with `"style-switch held, release required before refire"` until the user releases the dictate key too.

*The Solution:* Feed a per-key release signal into the filter — diff `keys_held` and call `releaseHotkey` for the specific actions whose physical keys just went up — rather than gating on the all-keys-up state. Add an integration test for "hold dictate + cycle style twice" (the existing `hotkey-filter.utils.test.ts` only exercises the dead per-action path, so it cannot catch this).

### [Major — CI/Verification] The PR is not actually green; "verification passed" is misleading
`docs/HANDOFF.md` (added) · PR body "Verification" section

*The Problem:* The PR body claims "TypeScript check-types: PASS · Tests: 71/71 suites pass". Reality: (a) the body itself admits **701/755 tests pass — 54 tests fail**, hand-waved as "API-key dependent integration tests"; the plan's DoD requires `test … green`, and 54 failures is not green unless every one is genuinely an integration test gated on a missing key — which should be asserted by the suite (skipped), not counted as failures; (b) `docs/HANDOFF.md` documents that the Ubuntu Rust-transcription job **timed out at 20 minutes** on PR #105 and that a workflow change (`timeout-minutes: 45`) could not even be pushed due to missing `workflows` scope. `gh pr checks 105` shows every job still `pending`, so "CI Verification: Passing" cannot be substantiated and the known Ubuntu timeout is unaddressed in-repo.

*The Solution:* Either mark the API-key tests with a real skip/conditional so the suite reports green in CI, or fix them; land the Ubuntu timeout increase (or a network-less test path); and correct the PR body's verification claims.

### [Major — A11] Scope largely unimplemented, and clipboard labels are hardcoded English
`apps/desktop/src/components/common/ContextMenu.tsx:515-546` · grep of `useContextMenu`/`useSurfaceContextMenu` usages

*The Problem:* A11 requires wiring an inventory of surfaces (transcriptions, dictionary, styles, chats, composer) and *"Zero default webview context menus anywhere in the app."* The implementation ships only a single generic clipboard menu for inputs. `useContextMenu` and `useSurfaceContextMenu` are exported but **never imported anywhere** (dead API), no page is wired with contextual items, and right-click on non-input surfaces still falls through to the default webview menu (the provider only `preventDefault()`s for inputs, `:506`). Separately, the clipboard items use raw string literals `label: "Cut" | "Copy" | "Paste" | "Select All"` (`:515,524,533,543`), violating A11's *"Every item label via FormattedMessage/useIntl"* — the app ships a full react-intl catalog, and this menu will render English in every locale.

*The Solution:* Wire the high-value surfaces with contextual items through the existing hook, route all labels through `useIntl`/`FormattedMessage`, and either implement true app-wide default suppression or explicitly descope it with rationale (per the plan's DoD), rather than implying completeness.

---

## Minor findings

### [Minor — A04] `isStreamingStable` is dead code and its logic is wrong
`apps/desktop/src/utils/assistant-pill-text.utils.ts:320-328`

*The Problem:* Never referenced anywhere. As written, its `opens` regex `` /^`{3}(\w+)?\s*$/gm `` also matches a bare closing fence, so a **complete** fenced block (`` ```js `` … `` ``` ``) counts 2 "opens" vs 1 "close" and reports "not stable". It also only counts backtick fences even though `FENCE_CHARS` (line 30) includes tilde `0x7e` — a tilde fence is invisible to the stability check.

*The Solution:* Delete it, or fix the fence accounting and add a real test. Leaving a broken exported helper is worse than removing it.

### [Minor — A04] The streaming-stability guarantee in the header comment is false
`apps/desktop/src/utils/assistant-pill-text.utils.ts:8-11` vs. its own `isStreamingStable` doc

*The Problem:* The header claims *"The output of the full text equals the concatenation of chunk outputs for the same boundary,"* but the fence handler (`inFence` is a per-call local, `:169-181`) means a chunk starting mid-fence (or an inline-code/backtick, bold marker, or link spanning a boundary) does not round-trip. `isStreamingStable`'s own docstring admits the property fails for an unclosed fence. The plan *requires* a streaming-stability test; none exists.

*The Solution:* Correct the docstring to state the actual contract (the consumer re-processes the full accumulated message each sync — see `OverlaySyncSideEffects.ts:79` — so it is safe), and add the mandated chunk-boundary test.

### [Minor — A11] `stateRef` assigned during render and never read
`apps/desktop/src/components/common/ContextMenu.tsx:312-313`

*The Problem:* `const stateRef = useRef(state); stateRef.current = state;` writes a ref during render — the exact anti-pattern `REVIEW.md` §4.1 flags for StrictMode — and `stateRef` is then never used again. Dead code plus an anti-pattern.

### [Minor — A19] En-dash "replacement" is a no-op and some slop patterns are case-inconsistent
`apps/desktop/src/utils/humanize.utils.ts:26-44`

*The Problem:* `/\s*–\s*/g → " – "` re-spaces the en-dash but **keeps** it — the scrubber's stated purpose is removal. Separately, `\butilize\b/gi`, `\bUtilizes\b/g`, `\bUtilized\b/g` mix case-insensitive and case-sensitive forms, so `UTILIZES`/`UTILIZED` escape scrubbing. Minor, but it undercuts the "conservative but complete" framing.

### [Minor — A11] Focus is taken but never restored on close
`apps/desktop/src/components/common/ContextMenu.tsx:172` (`autoFocus`), no restore logic

*The Problem:* A11 requires "menu takes focus while open, **restores focus on close**". `autoFocus` grabs focus; nothing returns it to the previously focused element when the menu closes, so keyboard users lose their place.

---

## Nitpick findings

- `ContextMenu.tsx:488-490` — `navigator.platform` is deprecated; macOS detection should use `navigator.userAgentData?.platform` / `navigator.platform` fallback.
- `ContextMenu.tsx:519,528,537,544` — `document.execCommand("cut"/"insertText"/"selectAll")` is deprecated and unreliable in a Tauri webview; the `NOSONAR` comments acknowledge but don't fix it — Cut/Paste may silently no-op while the clipboard write still happens (Copy of a selection + failed Cut leaves the selection in place). Prefer the existing Rust clipboard/input commands (`copy_to_clipboard`, `get_selected_text`, `paste`) instead of re-implementing in-page.
- PR body "Remaining (out of scope)" lists **A23 (thock haptics)** as not done, but A23 *was* implemented (`system/audio_feedback.rs`, `thock-*.wav`, pill `input.rs`/`ipc.rs`). The description contradicts the diff — a rival reviewer will read this as the summary lying about its own contents.

---

## UI review findings

- **No un-themed flash:** the context menu uses `background.paper`, `divider`, `shadows[8]`, `primary.main`/`error.main` tokens — theme continuity is correct. ✅
- **Accelerator hints** are hardcoded (`\u2318` vs `Ctrl`, `modKey + "+X"`) and, combined with the hardcoded labels (Major #4), the menu is not localized — the only "UI review" blocker beyond the crash.
- The menu is positioned via an *estimated* 180 px width (`MENU_MIN_WIDTH`) even though a wide item can exceed it, so the right-edge clamp (`computePosition`) can let a wide menu overflow the viewport.

---

## Missing important test coverage

1. **ContextMenu** — zero tests. A11 mandates: open-at-position, viewport clamp, item-click-calls-action-and-closes, Escape/scroll/blur close, keyboard nav, single-instance, disabled items, and a per-surface test. None exist, which is precisely why the `nativeEvent` crash (Critical) shipped.
2. **A04 streaming stability** — the plan's explicit chunk-boundary property test is absent; only static whole-document cases are covered.
3. **A21 hold-to-talk style cycling** — no test covers "dictate held + two consecutive style switches"; the existing test exercises the production-dead per-action `releaseHotkey` path.
4. **A19 prompt wiring** — the plan asks for a test that the humanize skill is included in assembled prompts; no such test (or wiring) exists.
5. **A23 rate-limiter** — `thock_limiter::should_throttle` has no unit test despite the plan calling for "rate-limiter logic (pure function)".

---

## What is working correctly

The Rust-side hardening in this PR is genuinely strong and worth keeping:

- **`private_http_request`** (`commands.rs:712`) replaces the removed plain-HTTP plugin scope (`capabilities/default.json`) with a far safer primitive: real IP parsing (`validate_private_http_url`, rejecting `10.evil.example` glob bypasses and `169.254.169.254`/IMDS), `.no_proxy()` to defeat environment-proxy pivots, per-hop redirect validation, header/method allow-lists, dual size caps, and race-safe cancellation via registration-ID guards — with thorough tests. This is a *real* tightening over the old hostname-glob capability, not a band-aid.
- **`run_terminal_command`** (`commands.rs`) — allow-listed binaries, shell-free tokenization, forbidden-character set, capped concurrent stdout/stderr readers that keep draining, and kill+reap on timeout. Matches `REVIEW.md` §3.1 exactly.
- **Path/symlink confinement** for audio import/read/delete (`resolve_managed_audio_path*`, canonicalization + Unix dev/inode and Windows volume/file-index TOCTOU checks) follows §3.2 precisely, including the "operate on the returned `PathBuf`, never the raw string" rule.
- **Installer/signature download** — per-hop namespace + extension validation, `Content-Length` pre-check and per-chunk cap, and minisign verification before `open`.
- **A04 wiring location** is correct — the single choke point in `OverlaySyncSideEffects.ts:79` (`markdownToPillText(rawContent, { maxLength: 600 })`), keeping the webview chat untouched, exactly as the plan's "TS is the brain" rule dictates.
- **`ReentryGuard`** (compare-exchange + `Drop`) for serializing clipboard/typing/audio commands is a clean idiom that survives panics.
- The privacy-wipe schema test derives tables from live migrations rather than a hardcoded copy (`user_data_tables_to_clear_covers_the_privacy_set`), satisfying `REVIEW.md` §3.5's anti-tautology requirement.
