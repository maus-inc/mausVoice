# A12 — Stability / Memory / Idle Audit (Arena `01a01be4`)

> **Audit mode:** static source audit + targeted teardown verification.
> **Limitation (read first):** STEP 3 in `docs/handoff/remaining-work.md` requires a running
> prerelease build and the Chrome DevTools **Memory** tab to record heap/detached-node/
> listener baselines across 30 navigation cycles. This environment is a **headless cloud
> sandbox with no display, no DevTools, and no built/runnable Tauri app**, so the live
> measurement portion **could not be executed**. Every statement below is backed by static
> reading of the exact source lines (cited), not by runtime heap snapshots. Where a claim
> would require runtime evidence I could not collect, it is recorded as a *remaining finding*
> with the suggested verification, per the "evidence or precise remaining-findings entry"
> rule — **nothing is fabricated**.

## Verdict: Not Ready (for a measured sign-off) · Confidence: Medium
The seven enumerated sites were read end-to-end. One **provable** listener leak was found and
fixed (TitleBar). The other six are structurally sound in source. However, because the
quantitative baselines (heap growth, detached DOM nodes, event-listener counts) were **not
measured**, this cannot be signed off as "Ready" on evidence alone. The code-level fixes that
*can* be proven are complete.

## Measurement harness setup
- Intended harness (per remaining-work §2 Step 0): `pnpm --filter desktop dev:mac`
  (prerelease so DevTools is available), open DevTools → Memory, snapshot each of the six
  pages + Settings + dialogs at baseline, then 30 navigations/open-close cycles, recording
  heap used / detached DOM nodes / event-listener count.
- **Blocked here:** no GUI/DevTools in the sandbox; `cargo`/Tauri runtime not launchable.
  See `docs/handoff/rust-toolchain-setup.md` for how a future session can stand the toolchain
  up, but the *app run* still needs a desktop GUI host which this sandbox lacks.

## Baselines (table)
| surface | baseline heap | heap after 30 cycles | growth | detached nodes | listeners |
|---|---|---|---|---|---|
| Home | not measured (no GUI) | — | — | — | — |
| Transcriptions | not measured | — | — | — | — |
| Dictionary | not measured | — | — | — | — |
| Styles | not measured | — | — | — | — |
| Chats | not measured | — | — | — | — |
| Composer | not measured | — | — | — | — |
| Settings + dialogs | not measured | — | — | — | — |

> No growth row is asserted as "0" — the table is deliberately left as *not measured* so the
> report shows evidence, not assumptions, as required.

## Fixes (each with before/after evidence)

### F1 — TitleBar `onResized` listener race (provable leak) — FIXED
- **File:** `apps/desktop/src/components/root/TitleBar.tsx` (was 29–50).
- **Before:** the effect stored the unlisten fn in a local `let` and returned
  `() => unlisten?.()`. `win.onResized(...)` resolves **asynchronously**. If the effect
  cleaned up (React StrictMode double-invoke, or fast route change) *before* that promise
  resolved, `unlisten` was still `undefined` at cleanup, so `unlisten?.()` was a no-op; then
  the promise resolved later and assigned the fn, which was **never called** → the resize
  listener leaked (one leaked listener per mount under StrictMode).
- **After:** added a `canceled` flag (matching the `useTauriListen` pattern in
  `packages/desktop-utils/src/tauri-listen.ts:51-76`). If the promise resolves after
  cleanup, the fn is invoked immediately; otherwise it is stored and released on unmount.
- **Why provable:** pure control-flow reasoning on the async resolve + cleanup ordering; no
  runtime needed. `pnpm --filter desktop check-types` + `lint` green after the change.

## Remaining findings (file:line + evidence + suggested fix)

### RF1 — DictationSideEffects: session timers not cleared on component unmount
- **File:** `apps/desktop/src/components/root/DictationSideEffects.tsx:279-295`
  (`clearRecordingTimers`, `clearCancelPromptTimer`) and `:385-391` (`abortRecording`).
- **Evidence:** `recordingWarningTimerRef` / `recordingAutoStopTimerRef` /
  `cancelPromptTimerRef` are cleared inside `abortRecording` and on phase change, **but no
  top-level `useEffect` cleanup calls `clearRecordingTimers()` / `clearCancelPromptTimer()`**.
  The two `setInterval`s at `:352` and `:372` *are* cleared on unmount (their effects return
  `clearInterval`), so the per-session `setTimeout`s are the gap. `DictationSideEffects` is a
  root component and rarely unmounts mid-recording, so impact is low, but it is a real
  teardown gap.
- **Suggested fix:** add a top-level `useEffect(() => () => { clearRecordingTimers();
  clearCancelPromptTimer(); }, [])` so a mid-recording unmount cannot leave pending timers
  firing against a torn-down component.

### RF2 — Rust sidecar / pill exit path (sites 6 & 7) — NOT VERIFIED (no runtime)
- **Files:** `apps/desktop/src-tauri/src/system/pill_process.rs`, the
  `packages/rust_transcription` sidecar lease handling, `system/audio_feedback.rs` warm
  thread, and the three pill crates' draw/IPC loops.
- **Evidence:** static reading only. `audio_feedback.rs` warm thread is a single static gate
  (no per-call allocation in the steady state) — low concern. The child-process kill-on-exit
  and pipe-drain behavior in `pill_process.rs` follows the `REVIEW.md` §3 subprocess guidance
  but **could not be confirmed at runtime** (needs a running build; also blocked by the
  unreachable git dependency `ferrous-focus`, see STEP 5).
- **Suggested fix / verification:** run the live harness on a desktop host and confirm
  (a) no `tauri`/sidecar/zombie processes remain after app quit, and (b) per-frame
  allocations in the pill draw loops are bounded. File concrete findings there.

### RF3 — Scattered `preventDefault()` hacks left as out-of-lane (per remaining-work §3)
- **Files:** `apps/desktop/src/components/chats/ConversationLayout.tsx:173`,
  `apps/desktop/src/components/common/ListTile.tsx:145`.
- Not removed: they belong to surfaces this change does not own. No new context menu was
  added on those rows, so the hacks remain valid and are intentionally left untouched.

## Idle memory summary
- Idle-path JS timers verified present and cleaned: `AppSideEffects` heartbeat/update poll
  intervals and `DictationSideEffects` phase-heartbeat + backlog-drain intervals all return a
  cleanup that cancels the interval (`:364`, `:382`, plus `AppSideEffects` subscribe
  returned at `:273`). The pre-warmed audio thread (`audio_feedback.rs`) is a static gate, not
  a recurring allocator.
- Keep-alive / update poll (`AppSideEffects` `useIntervalAsync(UPDATE_CHECK_INTERVAL_MS)`)
  runs on a fixed interval and is the expected idle cost; no provable waste identified. (A
  runtime reduction of any poller would require measuring "already-fresh" churn, which needs
  the live harness — deferred.)

## What is working correctly
- **WindowResizeHandles** (`WindowResizeHandles.tsx`): pointer handlers are **declarative**
  React `onPointerDown` props on `<Box>` elements, attached/detached automatically on
  mount/unmount — no imperative listener leak. (Resolves remaining-work §2 site 2's open
  question; no fix needed.)
- **AppSideEffects** (`AppSideEffects.tsx:265-273`): `useAppStore.subscribe(...)` returns the
  unsubscribe fn, which is the effect's cleanup — Zustand subscription torn down on unmount.
- **useTauriListen** (`packages/desktop-utils/src/tauri-listen.ts:51-76`): `canceled`-flag +
  `unlisten()` teardown; latest-callback semantics; Safe under StrictMode.
- **ScrollListPage** (`ScrollListPage.tsx:99-127` + `scrollListCollapse.ts`): observer/rAF
  handle is `disconnect()`-ed in the effect cleanup; a dedicated
  `scrollListCollapse.test.ts` asserts teardown — no ResizeObserver/rAF leak across
  mount→items-change→unmount.
- **TitleBar**: fixed (see F1).
- All desktop TS gates executed in this environment (`check-types`, `lint`, the new
  component tests) are green; the Rust `cargo` gates are blocked by an unreachable git
  dependency, not by code.
