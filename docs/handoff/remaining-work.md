# Deterministic Handoff — Remaining Work (A12 · A23 test · A11 wiring)

This is the complete, self-contained specification for the three items that
remain open on `arena/01a01be4-mausvoice` after the audit. Each section is
written so a smaller model (or another engineer) can execute it without
re-deriving the context. **Do the work in the order given** — A11 last, because
it must compose with the ContextMenu component already shipped on this branch.

Ground rules that apply to every section (from `docs/ui-behavioral-issues-plan.md`
and `REVIEW.md`):

- `apps/desktop` is Tauri 2: "Rust is the API, TypeScript is the Brain".
- User-facing strings go through `<FormattedMessage defaultMessage="…"/>` or
  `useIntl()` — never pass an `id` prop. After changing strings run
  `pnpm --filter desktop i18n` (extract + sync) and commit the locale diff.
- After any `#[tauri::command]` signature change run `pnpm gen:bindings`
  (or `scripts/bindings.sh`).
- Quality gates per touched package:
  - desktop TS: `pnpm --filter desktop check-types && pnpm --filter desktop lint && pnpm --filter desktop test`
  - Rust crate: `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
  - root: `pnpm run build`
- Do not fix things outside the described lane; record them as "out-of-lane
  findings" in your report instead.

---

## 1. A23 — Add the missing thock rate-limiter unit test

### Status
`apps/desktop/src-tauri/src/system/audio_feedback.rs` ships a rate limiter that
has **no test**, but the plan's A23 TESTS section explicitly requires
"rate-limiter logic (pure function)". This is the only A23 deliverable that is
still open.

### Current code (read it first — lines ~154-182 of `audio_feedback.rs`)
```rust
mod thock_limiter {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const THROTTLE_MS: u64 = 100;

    static LAST_THOCK_MS: AtomicU64 = AtomicU64::new(0);

    pub fn should_throttle() -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let last = LAST_THOCK_MS.load(Ordering::Relaxed);
        if now.saturating_sub(last) < THROTTLE_MS {
            return true;
        }
        LAST_THOCK_MS.store(now, Ordering::Relaxed);
        false
    }
}
```

### Required change (deterministic — do exactly this)

1. Extract the decision logic into a **pure, timestamp-injected** function so it
   is testable without sleeping or reading the wall clock:

```rust
mod thock_limiter {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    const THROTTLE_MS: u64 = 100;

    static LAST_THOCK_MS: AtomicU64 = AtomicU64::new(0);

    /// Pure decision: true when `now_ms` is within THROTTLE_MS of the last
    /// accepted timestamp. On accept, records `now_ms` and returns false.
    fn should_throttle_at(now_ms: u64) -> bool {
        let last = LAST_THOCK_MS.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last) < THROTTLE_MS {
            return true;
        }
        LAST_THOCK_MS.store(now_ms, Ordering::Relaxed);
        false
    }

    pub fn should_throttle() -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        should_throttle_at(now)
    }
}
```

2. Add tests in the **same module** (so they can reach the private `static`), in
   a `#[cfg(test)] mod tests { … }`. Because `cargo test` runs tests on parallel
   threads, **reset `LAST_THOCK_MS` to `0` at the start of every test** and do
   not rely on cross-test ordering:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        LAST_THOCK_MS.store(0, Ordering::Relaxed);
    }

    #[test]
    fn first_thock_is_not_throttled() {
        reset();
        assert!(!should_throttle_at(1_000));
    }

    #[test]
    fn within_window_is_throttled() {
        reset();
        assert!(!should_throttle_at(1_000));   // accept at t=1000
        assert!(should_throttle_at(1_050));    // 50ms later -> throttled
        assert!(should_throttle_at(1_099));    // 99ms later -> throttled
    }

    #[test]
    fn at_or_past_window_is_reenabled() {
        reset();
        assert!(!should_throttle_at(1_000));
        assert!(!should_throttle_at(1_100));   // exactly 100ms -> accept
        assert!(!should_throttle_at(1_250));   // past window -> accept
    }

    #[test]
    fn clock_skew_backwards_is_safe() {
        reset();
        assert!(!should_throttle_at(2_000));
        // `saturating_sub` must not panic or un-throttle on a backwards clock.
        assert!(should_throttle_at(1_900));    // 1900 - 2000 saturates to 0 < 100
    }
}
```

### Verification (must all pass; run from repo root)
```bash
cargo test -p mausvoice-desktop system::audio_feedback -- --test-threads=1   # if the crate is named mausvoice-desktop
# or, if package name differs, `cargo test -p <pkg> audio_feedback`
cargo fmt --check
cargo clippy -- -D warnings
```
If the crate package name is not `mausvoice-desktop`, find it via
`grep '^name' apps/desktop/src-tauri/Cargo.toml` and use that.

### DoD
- `should_throttle_at` is pure and unit-tested (all four cases above).
- `should_throttle()` behavior is unchanged (still reads the wall clock).
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` green.

---

## 2. A12 — Stability / memory / idle audit (measurement-backed)

### Status
The **implementation** hardening the plan enumerates already exists in this
checkout (verified):
- `apps/desktop/src/hooks/async.hooks.ts` — `AsyncDataController` uses a monotonic
  generation counter and clears its timeout on cancel/unmount.
- `packages/desktop-utils/src/tauri-listen.ts` — `useTauriListen` has a `canceled`
  flag + `unlisten()` teardown and latest-callback semantics.
- `useAsyncEffect` (same `async.hooks.ts`) chains the previous effect's cleanup.

What is **missing** is the A12 **deliverable**: the measurement harness,
baselines, before/after metrics, and the consolidated report. This must be done
on a running app and cannot be fabricated from static reading.

### Step 0 — Build the measurement harness (prerelease build)
A06 gates dev surfaces behind a prerelease build. Use it so DevTools is available:
```bash
pnpm --filter desktop dev:mac    # or dev:windows / dev:linux
```
In the running app, open DevTools (right-click → Inspect, available only in the
prerelease build), go to the **Memory** tab.

### Step 1 — Record baselines
For each of the six pages (Home, History/Transcriptions, Dictionary, Styles,
Chats, Composer) plus the Settings and each dialog you can reach:

1. Load the page, wait 5s idle, take a heap snapshot ("baseline").
2. Navigate away and back **30 times**, waiting 2s each time.
3. Take a final snapshot and record **heap used**, **detached DOM node count**,
   and **event-listener count** (Chrome DevTools Memory → "Event Listeners" panel
   or the console `getEventListeners` on repeated elements).

Record a table: `surface | baseline heap | heap after 30 cycles | growth | detached nodes | listeners`. Growth must be recorded even if it is zero — the report must show evidence, not assertions.

### Step 2 — Audit these specific sites (verify teardown, do not fix unless proven)
Read each and confirm the cleanup path actually runs on unmount/dep change. Only
fix what you can **prove** leaks (listener count grows across cycles, or a
detached-node count that never drops):

1. `apps/desktop/src/components/root/TitleBar.tsx:31-49` — `onResized` unlisten
   (currently present via `return () => unlisten?.();`). Verify the promise-race:
   if `onResized` resolves *after* unmount, is the unlisten still called? (The
   `canceled`-flag pattern in `tauri-listen.ts` is the correct fix if it isn't.)
2. `apps/desktop/src/components/root/WindowResizeHandles.tsx` — per-pointer
   handlers; verify `pointerdown/pointermove/pointerup` listeners are removed
   (this file has no `useEffect` teardown visible in the grep — **verify and, if
   the pointer listeners are added imperatively without removal, fix**).
3. `apps/desktop/src/components/root/AppSideEffects.tsx` — many `useTauriListen`
   calls + one Zustand `subscribe` keyed on `hotkeyGrabFingerprint`. Verify the
   subscribe returns an unsubscribe and is wired to effect cleanup.
4. `apps/desktop/src/components/root/DictationSideEffects.tsx` — session timers
   (`cancelPromptTimerRef`), listeners, refs. Verify teardown on unmount and on
   phase change (stop/abort).
5. `apps/desktop/src/components/common/ScrollListPage.tsx` — already reworked by
   A02; verify no ResizeObserver/rAF leak remains across mount→items change→unmount.
6. Rust: `apps/desktop/src-tauri/src/pill_process.rs` (child processes),
   `packages/rust_transcription` sidecar leases, `system/audio_feedback.rs` warm
   thread — verify the process-exit path kills children and drains pipes per
   `REVIEW.md` §3.1 (capped concurrent readers, kill+reap on timeout).
7. Pill crates: per-frame allocations in the draw loops (macOS Cairo /
   Windows D2D / GTK) and IPC reader threads — verify clean exit.

### Step 3 — Idle memory
While idle (no recording, no agent turn), identify what runs: keepalive timers
(`platform/windows/window.rs` `start_webview_keepalive`), update poll
(`AppSideEffects` `useIntervalAsync(UPDATE_CHECK_INTERVAL_MS, …)`), remote-receiver
pollers, pre-warmed audio thread. Reduce only provable waste (e.g. a poller that
runs after its data is already fresh), and keep instant-resume intact. Document
any poller you decide to keep and why.

### Required report (this is the deliverable — omit none)
Use the exact `REVIEW.md` §2.5 structure:
```
## Verdict: Ready / Not Ready   Confidence: High/Medium/Low
## Measurement harness setup
## Baselines (table)
## Fixes (each with before/after evidence)
## Remaining findings (file:line + evidence + suggested fix)
## Idle memory summary
## What is working correctly
```

### DoD
- Table of baselines + growth for the six pages + dialogs, with evidence.
- Zero known listener/observer leaks in the audited components (or a precise
  remaining-findings entry for each).
- Clean process exit (no lingering sidecars/zombies).
- Full suite green (check-types, lint, test, cargo fmt/clippy/test, build).

---

## 3. A11 — Wire the contextual context menus (finish the inventory)

### Status
The shared component `apps/desktop/src/components/common/ContextMenu.tsx` and the
text-input clipboard menu already work and are tested. **No page surface is wired.**
The plan requires the inventory (transcriptions, dictionary, styles, chats,
composer, home, plus a default app-level menu) to be wired OR explicitly descoped
with a written rationale. This section wires them.

### The two mechanisms you have (use these, do not invent new ones)
- `useContextMenu()` → `{ handleContextMenu, renderMenu, closeMenu }`.
  `handleContextMenu(e.nativeEvent, items, surfaceKey)` where `items` is
  `ContextMenuItem[]`.
- `ContextMenuProvider` (already mounted at `Root.tsx:52`) intercepts global
  right-clicks and shows the clipboard menu **only on inputs**. It leaves all
  other targets to the default webview menu, so wiring a surface = adding a local
  `onContextMenu` handler on that surface's row/container.

### Item ordering rules (follow exactly)
- Common verbs first (Copy / Open / Edit), destructive verbs **last** with
  `danger: true` and `error.main` color, separators (`{ kind: "divider" }`)
  between groups.
- Every label via `useIntl().formatMessage({ defaultMessage: "…" })`.
- Disabled states with a reason when an action cannot run (e.g. Copy when nothing
  selected).

### Surface-by-surface spec (exact items, in order)

**A. Transcriptions / History — `TranscriptRow.tsx`**
Wire `onContextMenu` on the row (or its container in `TranscriptionsPage.tsx`).
Items, reusing the existing handlers:
1. **Copy text** → `handleCopyTranscript(transcription?.transcript ?? "")` (already
   implemented at `TranscriptRow.tsx:96`).
2. **Copy ID** → copy `id` via `navigator.clipboard.writeText(id)` then the existing
   `"Copied successfully"` snackbar (match `handleCopyTranscript`'s pattern).
3. **Open details** → `openTranscriptionDetailsDialog(id)` (`handleDetailsOpen`,
   `:92`).
4. **Retranscribe** → `openRetranscribeDialog(id)` (`:288`).
5. `{ kind: "divider" }`
6. **Delete** (danger) → `handleDeleteTranscript(id)` (`:111`).

**B. Dictionary — `DictionaryRow.tsx`**
1. **Edit** → reuse whatever the row's edit affordance calls (if the row has no
   edit, `openTermEditor`/equivalent — find the existing entry point; if none,
   record it as an out-of-lane finding and omit Edit rather than inventing one).
2. `{ kind: "divider" }`
3. **Delete** (danger) → `handleDelete` (`DictionaryRow.tsx:76`).

**C. Styles — `ManualStylingRow.tsx`**
1. **Edit** → `openToneEditorDialog({ mode: "edit", toneId: id })` (`handleEdit`,
   `ManualStylingRow.tsx:52`).
2. `{ kind: "divider" }`
3. **Delete** (danger) → `deleteTone(id)` from `tone.actions.ts:51` (show the same
   confirmation/snackbar the row's delete affordance uses; reuse it, don't fork).

**D. Chats — `ConversationListItem.tsx` (list) and `ChatMessageBubble.tsx` (message)**
- List item: **Rename** (if a rename entry point exists — reuse it), divider,
  **Delete conversation** (danger) → `deleteConversation(id)` from
  `chat.actions.ts:56`.
- Message: **Copy message** → copy `content` to clipboard; if none, omit.

**E. Composer — `ComposerPage.tsx`**
The text area is already covered by the input clipboard menu (Cut/Copy/Paste/
Select All) via the provider. **Do not re-add** those. If the composer has a
"review"/"accept suggestions" action, add it above a divider; otherwise leave the
composer to the provider's input menu and record that decision.

**F. Home — `HomePage.tsx`**
Add a default app-level menu on empty areas: **Refresh** (re-trigger the page's
data load) and nothing else. If Home has no refresh entry point, record it as
descoped.

### Cross-cutting requirements
- **Do not** duplicate the provider's clipboard logic; surfaces A–D are non-input
  rows, so they use `useContextMenu()` directly, not the provider.
- Remove the scattered `preventDefault()` hacks only where they now become menu
  items you own (`ConversationLayout.tsx:173`, `ListTile.tsx:145`). If a hack
  belongs to a surface you are not wiring here, **list it as a finding**, do not
  delete it.
- Verify no "Inspect" item appears anywhere (A06 already gates devtools; do not
  add one).
- Every new label goes through i18n and `pnpm --filter desktop i18n` must be run.

### Required tests (component tests, jsdom + vitest, matching
`ContextMenu.test.ts` conventions in the same directory)
For **each** wired surface, one test file `<Surface>.test.ts(x)` that:
1. renders the row with the necessary mocked store/repos,
2. dispatches a `contextmenu` MouseEvent on the row,
3. asserts the expected menu items (labels + presence of the divider + danger
   item last),
4. clicks the destructive item and asserts the repo/action mock was called.

Reuse the `vi.mock("react-intl", …)` and `IS_REACT_ACT_ENVIRONMENT` setup already
in `ContextMenu.test.ts` so labels render as `defaultMessage` strings.

### DoD
- Surfaces A–D wired (F/E wired or explicitly descoped with a one-line rationale
  in the report).
- `pnpm --filter desktop check-types && lint && test` green (new tests included).
- `pnpm --filter desktop i18n` run and the locale diff committed.
- A short report listing: surfaces wired, surfaces descoped + rationale, and any
  scattered `preventDefault()` hacks left as out-of-lane findings.
