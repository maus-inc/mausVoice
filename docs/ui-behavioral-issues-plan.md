# mausVoice — UI/Behavioral Issue Triage: Fully Scoped Per-Item Agent Plans

> **Purpose.** This document converts every item in the "Recent Build Surfaced Some UI/Behavioral Issues" note into one fully scoped, end-to-end agent assignment. Each item gets its own agent, its own grounded file map (verified against this checkout at `078a7fc`), its own walkthrough, tests, i18n notes, and definition of done. **Nothing in this document is implemented yet.** Agents receive a maximally sized lane: they investigate, fix at the root, prove it with tests, and polish — without stepping on another agent's files.
>
> **How to use.** Run agents in the waves defined below. Copy the *GLOBAL PREAMBLE* plus one agent block into each agent. A block is self-contained and repo-relative; it never depends on another agent's output to start (dependencies are only about file-ownership order, and the "Ground truth" section restates everything needed).

---

## 1. GLOBAL PREAMBLE (copy into every agent)

```markdown
You are working in the mausVoice monorepo (maus-inc/mausVoice), a Turborepo + pnpm workspace.
Branch: arena/01a01761-mausvoice. Work only on this branch.

REPO RULES (non-negotiable)
- apps/desktop is a Tauri 2 app. "Rust is the API, TypeScript is the Brain": all business
  logic lives in TypeScript; Rust provides pure capabilities with no decision-making.
- State: Zustand + Immer (apps/desktop/src/state/*, store at src/store/index.ts).
- Data flow: event -> action (src/actions/) -> repo (src/repos/) -> Tauri command
  (src-tauri/src/commands.rs, registered in src-tauri/src/app.rs invoke_handler) ->
  SQLite / transcription sidecar / external provider. Repos expose BaseXxxRepo/LocalXxxRepo;
  use toLocalXxx()/fromLocalXxx() at the Tauri boundary.
- i18n: user-facing strings use <FormattedMessage defaultMessage="..." /> or useIntl().
  NEVER pass an id prop. After changing strings run: pnpm --filter desktop i18n
- After changing a #[tauri::command] signature or exposed type: pnpm gen:bindings
- DB migrations: src-tauri/src/db/migrations/NNN_description.sql, registered in db/mod.rs.
  Numbering is intentionally irregular (021, 069, 070 absent). NEVER renumber applied migrations.
- CSP: tauri.conf.json script-src 'self' (no unsafe-inline/unsafe-eval). External provider
  domains live in the http:default permission set AND the CSP connect-src allowlist — keep both
  in sync when adding/removing providers. Never add a wildcard. Never expand
  dangerousDisableAssetCspModification beyond ["style-src"].
- Do not propose band-aids. Identify the root cause (architectural or logical) and fix it
  directly. Enforce DRY. Avoid over-engineering. Minimal impact — do not break existing
  behavior. Self-documenting code; comments only where non-obvious. Follow existing patterns
  (dialogs, state management, API interactions).
- Quality gates for touched packages:
  - desktop TS: pnpm --filter desktop check-types && pnpm --filter desktop lint && pnpm --filter desktop test
  - Rust: cargo fmt --check, cargo clippy, cargo test in the touched crate
  - root: pnpm run build before handoff.

INTERFERENCE CONTRACT
- You OWN the files listed in your block. Do NOT edit files owned by another agent
  (see the shared-file map in your block). If you discover a bug in someone else's lane,
  record it in your report under "Out-of-lane findings" — do not fix it.
- If you must consume a shared token/API, add it through the API surface you own
  (e.g. a helper in your own files) rather than rewriting the shared file.
- End-to-end means: trace the full chain (UI -> IPC -> Rust -> storage) for your item,
  fix every link in your lane, and leave every touched file formatted and green.

REPORT FORMAT at the end of your work
## What I changed (file:line level) / ## Root cause found / ## Tests added / ## i18n updated /
## Out-of-lane findings (for other agents) / ## Verification commands run and results.
```

---

## 2. Shared-file ownership map (the no-interference guarantee)

Every file that more than one item plausibly touches is listed with its owner sequence. Agents in later waves may only *consume* earlier changes, never rewrite them.

| Shared file | Agent order (sequential, never parallel) |
|---|---|
| `apps/desktop/src/components/common/ScrollListPage.tsx` | **A02 only** |
| `apps/desktop/src/components/common/ElasticSlider.tsx` + `theme.ts` MuiSlider area | **A07 only** |
| `apps/desktop/src/theme.ts` | **A07 → A14 → A16** |
| `apps/desktop/src/styles/shadows.ts` | **A14 → A16** |
| `apps/desktop/src/components/root/DictationSideEffects.tsx` | **A08 → A09 → A22 → A21** |
| `apps/desktop/src/components/root/AppSideEffects.tsx` | **A03 → A21** |
| `apps/desktop/src-tauri/src/commands.rs` | **A18 → A08 → A03** |
| `apps/desktop/src-tauri/src/app.rs` | **A06 → A03** |
| `apps/desktop/src/actions/tone.actions.ts` | **A09 → A22** |
| `apps/desktop/src/components/settings/RetranscribeDialog.tsx` | **A10 → A15** |
| `apps/desktop/src/components/transcriptions/TranscriptRow.tsx` | **A10 only** |
| `packages/rust_macos_pill|rust_windows_pill|rust_gtk_pill/src/draw.rs` | **A17 → A13 → A04** |
| `packages/rust_*_pill/src/input.rs` | **A22 → A23** |
| `packages/rust_*_pill/src/constants.rs` | **A13 → A23** |
| `apps/desktop/src/components/settings/ApiKeyList.tsx` + `AITranscriptionConfiguration.tsx` | **A05 → A24** |

## 3. Waves

- **Wave 1 (parallel, zero shared files):** A01, A02, A06, A07, A10, A18, A20, A24
- **Wave 2:** A05, A08, A14, A15, A17
- **Wave 3:** A03, A09, A13, A16, A22
- **Wave 4 (last):** A04, A12, A21, A23

Each wave must be fully green before the next starts. A12 (stability audit) runs last because it audits everything, fixes only what it can prove, and files findings for other lanes.

---

## Agent A01 — Home page double scrollbar

**Issue (verbatim):** "The 'Home' Page has 2 Side-scroll bars"

**Grounded context (verified):**
- `apps/desktop/src/components/common/PageLayout.tsx` renders an outer `Stack` with `overflowY: "auto", flexGrow: 1, minHeight: 0` that wraps every page's children.
- `apps/desktop/src/components/home/HomePage.tsx` wraps its content in `DashboardEntryLayout` (`apps/desktop/src/components/dashboard/DashboardEntryLayout.tsx`), which itself renders a `Stack` with `flexGrow: 1, overflowY: "auto", pr: 2`.
- Nested scroll containers on the same axis = two scrollbars and scroll-jacking: the inner one scrolls its own content, the outer one has nothing to scroll until layout quirks make it scrollable.
- Other list pages (`ScrollListPage`) are `overflow: hidden` + own scroller, so they do not double up — Home is the outlier because it composes `DashboardEntryLayout` inside the already-scrolling `PageLayout`.

**Root-cause hypotheses (verify in order):** (1) `PageLayout` and `DashboardEntryLayout` both claim `overflowY: auto`; (2) `pr: 2` on the inner scroller reserves a gutter that is never painted because the inner content is wider than the viewport, producing a horizontal scrollbar (the "2 side-scroll bars" may be one vertical + one horizontal); (3) `Container maxWidth="sm"` + `flex: 1` StatCards overflowing horizontally on narrow windows.

**Owns:** `DashboardEntryLayout.tsx`, `HomePage.tsx`, `PageLayout.tsx` (scroll behavior only), any dashboard page that composes `DashboardEntryLayout` (`DashboardPage.tsx` if it does).

```markdown
[Agent A01 — Home page double scrollbar]

MISSION
Make the Home page scroll with exactly one visible scrollbar on every window size and
theme, and eliminate any nested-scroll conflict between PageLayout and DashboardEntryLayout.

GROUND TRUTH
- PageLayout.tsx: outer Stack has overflowY:"auto", flexGrow:1, minHeight:0 and wraps children.
- DashboardEntryLayout.tsx: inner Stack has flexGrow:1, overflowY:"auto", pr:2.
- HomePage.tsx: uses DashboardEntryLayout; StatCards use flex:1 in a direction:"row" Stack.

WALK (end to end)
1. Reproduce: run the app (pnpm --filter desktop dev:mac / dev:windows / dev:linux, or the
   web build) and open Home at narrow (~400px), medium (~700px), and wide (~1200px) widths.
   Record exactly which scrollbars appear (vertical inner/outer, horizontal) at each width.
2. Trace the layout tree with DevTools: confirm whether the outer PageLayout scroller is
   scrolling anything while the inner one scrolls (check scrollTop of both while scrolling).
3. Decide the root fix: exactly ONE scroll container must own the Home scroll axis.
   Recommended: DashboardEntryLayout stops scrolling (flex column, overflow visible, minHeight 0)
   and lets PageLayout scroll; remove the now-unused pr gutter or move it to a non-scrolling
   wrapper. Alternatively flip it (PageLayout delegates scrolling to pages) — but that touches
   every page, which is out of lane. Pick the minimal correct option.
4. Fix horizontal overflow at the source: audit StatCard rows, DictationInstruction,
   GettingStartedList and TranscriptionRow for min-width/overflow issues at narrow widths;
   add flex-wrap or minWidth:0 where content legitimately needs to shrink. Do not hide
   scrollbars with CSS hacks.
5. Verify in BOTH light and dark mode (scrollbar styling comes from theme.ts global
   *::-webkit-scrollbar rules — do not edit theme.ts; A07/A14/A16 own it. If the scrollbar
   itself looks broken, file an out-of-lane finding).
6. Check every consumer of DashboardEntryLayout (grep for it) still renders identically
   except for the removed inner scrollbar.

REQUIREMENTS
- Root-cause fix; no `overflow-x: hidden` band-aids unless the overflow is proven to come
  from a cosmetic artifact (then document why).
- Keyboard + wheel scrolling still works on Home; Home SideEffects unaffected.
- No changes to ScrollListPage-based pages (History/Dictionary/Styles) — A02 owns those.

TESTS
- Add/extend a component test rendering HomePage (or a reduced DashboardEntryLayout fixture)
  and asserting there is exactly one element with a scrollable vertical overflow, and that
  the inner container's scrollHeight <= clientHeight (nothing scrolls twice).
- If the repo has no existing HomePage test, create the smallest meaningful one (fixture
  with mocked store state) — check src/__tests__ and test/ for conventions first.

I18N
- No new strings expected. If you change any, use FormattedMessage defaultMessage and run
  pnpm --filter desktop i18n.

DEFINITION OF DONE
- Home shows one scrollbar at 400/700/1200px widths, light + dark.
- pnpm --filter desktop check-types && lint && test green; root pnpm run build green.
- Report: root cause, files changed (file:line), tests added.

BOUNDARIES
- Do not touch: ScrollListPage.tsx (A02), theme.ts (A07/A14/A16), anything under src-tauri.
```

---

## Agent A02 — History/Dictionary/Styles scroll-collapse glitch + resource leak

**Issue (verbatim):** "When scrolling in the History, Dictionary, Styles. the transitioning between the large state with items to the smaller cleaner text only header, if a mid-transition or a scroll in between the two states, it starts glitch spasm, and even leaks/lags resources, fix that."

**Grounded context (verified):**
- The shrinking header lives in `apps/desktop/src/components/common/ScrollListPage.tsx` (485 lines) and is used by `DictionaryPage.tsx`, `TranscriptionsPage.tsx` ("History"), `StylingPage.tsx` and others.
- Mechanism today: a `useLayoutEffect` measures hidden "expanded"/"collapsed" header clones via `getBoundingClientRect` into `headerMetrics` state; a `ResizeObserver` observes **the scroller itself plus 4 header measure elements** and re-measures on every change; a scroll listener writes a `--p` CSS variable on the scroller; the visible sticky header's height is `calc(collapsedHeight + collapseDistance * (1 - var(--p)))` and the title `transform: scale(...)` uses the same variable.
- Feedback-loop suspects: (a) as the header collapses, scroller content height shrinks, the browser re-clamps `scrollTop`, the scroll handler writes a new `--p`, the header height changes again → oscillation ("spasm") exactly at mid-transition; (b) the ResizeObserver fires from header-height changes themselves (it observes the scroller whose content changes when the header shrinks) → re-measure → `setHeaderMetrics` → re-render → observe → loop; (c) two effects (`useLayoutEffect` measuring + `useEffect` scroll) both own `--p` with different schedules (rAF) that can interleave; (d) `titleScale = expandedTitleHeight / collapsedTitleHeight` is inverted (it should be collapsed/expanded) which can produce scale > 1 in the wrong direction; (e) repeated remounts re-create observers/rAF loops (leak).
- `items.length` is in both effect dep arrays: a mid-scroll data refresh (pagination, deletion) re-runs the measurement effect and resets the animation state mid-transition — another spasm trigger.

**Owns:** `ScrollListPage.tsx` exclusively. Its consumers (pages) must not be edited except for prop changes if absolutely required.

```markdown
[Agent A02 — Scroll-collapse glitch and resource leak in ScrollListPage]

MISSION
Eliminate the mid-transition "glitch spasm" and the resource leak/lag in ScrollListPage's
expanded->collapsed header transition, on History, Dictionary, Styles and every other
consumer, without regressing the visual design (large header with items -> smaller text-only
header while scrolling).

GROUND TRUTH
- ScrollListPage.tsx is the ONLY component implementing this transition.
- Current implementation details to interrogate (see file):
  * useLayoutEffect: measures expandedHeader/collapsedHeader/expandedTitle/collapsedTitle,
    computes collapseDistance, titleScale (=expanded/collapsed — check direction),
    titleHeightDelta; writes --p from scroller.scrollTop; ResizeObserver observes scroller,
    expandedHeader, collapsedHeader, expandedTitle, collapsedTitle.
  * useEffect [items.length]: scroll listener + rAF writer of --p.
  * Header height: calc(<collapsed>px + <collapseDistance>px * (1 - var(--p, 0))).
  * Title: transform scale(calc(1 + <titleScaleRange> * (1 - var(--p, 0)))).
  * Subtitle: opacity + scale/translate from --p. Hidden measure clones render when
    items.length > 0.
- Consumers (do not edit unless a prop change is unavoidable): DictionaryPage.tsx,
  TranscriptionsPage.tsx (History), StylingPage.tsx, and any other <ScrollListPage> usage
  (grep to enumerate).

WALK (end to end)
1. Reproduce deterministically: open History with enough items to scroll; scroll slowly
   through the collapse zone; then scroll fast and stop exactly mid-transition; then refresh
   items (delete a row / trigger loadMore) mid-transition. Record scrollTop/--p/header
   height over time (DevTools Performance + a temporary rAF probe). Identify which of the
   feedback loops (a)-(e) above actually fires, in order of dominance.
2. Design the fix at the root. Strong candidates (choose/combine, keep it simple):
   - Make the scroll handler the single writer of --p and make measurement passive:
     measure collapse geometry ONLY from the hidden clones (which never change height
     during scroll), not from the scroller or the visible header. Drop the scroller/visible
     elements from the ResizeObserver; observe only content-size inputs that genuinely
     change geometry (action node, title/subtitle content, container width via a dedicated
     resize probe if needed).
   - Break the scroll->height->scroll loop: when the header shrinks, keep the visual
     anchor stable (compensate scroller.scrollTop by the delta, or better: drive the
     collapse purely from a transform on the header content instead of resizing the
     sticky header's layout height, so scroller content height never changes during the
     transition).
   - Snapshot the progress BEFORE any items.length change and restore it after re-measure
     so a data refresh mid-transition continues smoothly instead of resetting.
   - Remove the dual ownership of --p (single writer, rAF-coalesced, idempotent value).
   - Fix titleScale math and add clamps so progress is always monotonic in scrollTop and
     scale stays in [1, 1+range].
3. Verify `overscrollBehavior: contain` and the sticky z-index/background behavior survive.
4. Check teardown: every observer/listener/rAF must be cancelled on unmount AND on dep
   change (the effect with [items.length] re-subscribes — prove nothing leaks by
   re-scrolling after several item-list mutations and watching listener count in DevTools).
5. Keep the empty-state branch (items.length === 0) unchanged in appearance.

REQUIREMENTS
- Root-cause fix. If you remove code (e.g. the hidden measure clones), remove it fully — no
  dead paths. Keep the public props API compatible; consumers stay untouched.
- Smoothness budget: no frame over ~8ms in the transition zone on a mid-range machine with
  200 rows; `willChange` hints must be justified (only while transitioning).
- Accessibility: prefers-reduced-motion users should get an instant (non-animated) collapse.

TESTS
- Unit-test the pure geometry/progress math if you extract it (make it a pure function:
  (scrollTop, collapseDistance) -> progress, clamped; and scale/title-height math).
- Add a test that the cleanup functions detach observers/listeners (mock ResizeObserver and
  count observe/disconnect calls across mount->items change->unmount).
- If feasible, add an integration test driving the scroller scrollTop and asserting --p
  stays clamped in [0,1] and header height stays stable when items refresh mid-scroll.

I18N
- No new strings expected.

DEFINITION OF DONE
- Mid-transition spasms and mid-transition data-refresh glitches are gone on History,
  Dictionary and Styles; scrolling feels linear in both directions.
- No listener/observer/rAF growth across 20 scroll + refresh cycles (measured).
- pnpm --filter desktop check-types && lint && test green; build green.
- Report with the measured root cause and before/after trace notes.

BOUNDARIES
- You own ScrollListPage.tsx. Do not edit theme.ts, PageLayout.tsx, DashboardEntryLayout.tsx
  (A01), or the consuming pages beyond an unavoidable prop.
```

---

## Agent A03 — "Always run as administrator" startup + Close-to-tray

**Issue (verbatim):** "When 'Always run as administrator' is enabled, instead of the app to launch with a small helper (e.g the popup that shows when a user clicks on No in the UAC prompt) before the UAC prompt comes up, instead of first loading the entire app. Clicking 'Close the app' in the popup that shows when a user clicks on No in the UAC prompt, only minimizes the app to tray, instead of killing the app process."

**Grounded context (verified):**
- Elevation is requested from the frontend AFTER full startup: `src/components/root/AppSideEffects.tsx` (~line 270) calls `requestAdminRelaunch()` in a `useEffect` once `prefs` hydrate and `prefs.alwaysRequestAdminOnStartup` is true (Windows only).
- `src/actions/native.actions.ts` → `src/repos/native.repo.ts` → `commands.requestAdminRelaunch()` (`src-tauri/src/commands.rs:2395`). The decline path sets `settings.elevationDeclinedDialogOpen = true`, which `src/components/root/ElevationDeclinedDialog.tsx` renders ("Launch normally" / "Close mausVoice").
- `ElevationDeclinedDialog`'s "Close mausVoice" calls `getCurrentWindow().close()`. But `src-tauri/src/app.rs` (~line 150) intercepts `WindowEvent::CloseRequested` for the `main` window with `api.prevent_close()` + `window.hide()` — i.e. every window close, including this dialog's, degrades to "hide to tray". That is exactly why "Close the app" only minimizes.
- A regression guard exists: `src/startup-elevation.test.ts` asserts the UAC relaunch is never called during Tauri `setup`.
- The "Always run as administrator" toggle lives in `src/components/settings/SettingsPage.tsx`; the pref is persisted (migration 074 per `docs/0.1.6-handoff-prompt.md`).
- Windows platform code: `src-tauri/src/platform/windows/*`, `commands.rs` request_admin_relaunch.

**Owns:** `commands.rs` (quit/elevation commands only), `app.rs` (close semantics only), `native.actions.ts`, `native.repo.ts`, `ElevationDeclinedDialog.tsx`, `AppSideEffects.tsx` (elevation effect only), `SettingsPage.tsx` (the admin toggle block only), `startup-elevation.test.ts`.

```markdown
[Agent A03 — UAC elevation startup order + real app kill from decline dialog]

MISSION
(1) When "Always run as administrator" is enabled, surface the minimal elevation helper
    BEFORE loading the full app: the user should see a tiny pre-flight surface, then the UAC
    prompt, and only the accepted (elevated) instance may spend resources loading the app.
(2) "Close the app" in the elevation-declined dialog must terminate the process (including
    the tray), not hide to tray.

GROUND TRUTH
- Today the entire webview boots, auth/prefs hydrate, and only then requestAdminRelaunch()
  fires from AppSideEffects.tsx (~line 270). Decline -> ElevationDeclinedDialog.
- app.rs ~line 150: CloseRequested(main) -> api.prevent_close() + window.hide() (tray
  behavior). TitleBar close and the dialog share this path, so the dialog cannot kill the app.
- commands.rs:2395 request_admin_relaunch; startup-elevation.test.ts pins "no relaunch
  inside setup()".
- "Rust is the API, TypeScript is the Brain": the DECISION to relaunch must stay a frontend
  decision; Rust only provides the capability + early visibility control.

WALK (end to end)
1. Verify current behavior on Windows (dev:windows): enable the pref, relaunch, confirm the
   full app loads before UAC; decline UAC; click "Close the app"; observe the window hides
   and the process + tray icon stay alive (Task Manager). This is your repro baseline.
2. Design the early-helper flow. Recommended shape (adjust to repo idioms):
   - Rust side: on launch with the autostart/elevation flag pending, show the main window
     as a minimal "preparing" surface (a dedicated light route/screen keyed off a state flag,
     e.g. a query/URL or a Tauri event) WITHOUT starting heavy subsystems; or keep the
     window hidden and show a tiny helper window. Whatever you choose, the full app
     (auth init, dashboard data, transcription setup) must not run until the elevation
     decision is resolved.
   - Frontend: move the requestAdminRelaunch() decision to the earliest point the pref is
     readable (prefs hydrate today — check whether the pref can be read synchronously from
     local state without the full app init; if it cannot, document the minimal subset that
     must load and keep it tiny).
   - Declined path: show ElevationDeclinedDialog as the helper's final state (this is the
     popup the note references) before any dashboard ever renders.
3. Add a real quit capability: a new Tauri command (e.g. quit_app / exit_application) that
   calls app.exit(0) (and, if needed, tears down tray + pill processes first). Register it
   in app.rs invoke_handler, regenerate bindings (pnpm gen:bindings), wrap it in the native
   repo, and call it from ElevationDeclinedDialog's "Close mausVoice" instead of
   window.close(). Keep the normal TitleBar close behavior (hide-to-tray) unchanged.
4. Keep the startup-elevation.test.ts invariant true (no relaunch inside setup()) and extend
   it: assert the quit command is registered; assert the close-request handler still
   hides the main window while the quit command is the only process-exit path.
5. Guard against double-relaunch races: if UAC was accepted, the OLD unelevated process
   must exit cleanly and not double-prompt or leave a zombie tray icon (check how the
   relaunch handshake works today and make the old process exit after spawning the new one).

REQUIREMENTS
- The happy path (UAC accepted) must look identical to today minus the wasted full-app load.
- The declined path must offer "Launch normally" (current behavior preserved) and
  "Close mausVoice" (now actually kills the process AND its tray icon).
- Non-Windows platforms: zero behavior change (guard everything behind windows-only).
- No new dependencies. Reuse existing dialog/tray/window idioms.

TESTS
- Extend startup-elevation.test.ts and any Rust-side tests: quit command registered;
  close-requested still hides; relaunch never invoked during setup.
- Add unit tests for the frontend effect (elevation decision timing) using the repo's
  testing conventions (vitest + mocked repos).

I18N
- Any new/changed user-facing strings via FormattedMessage defaultMessage; run
  pnpm --filter desktop i18n. (Also note: this dialog contains an em-dash string — A19
  owns the copy sweep; leave the wording unless you change the sentence.)

DEFINITION OF DONE
- Windows repro shows: enable pref -> relaunch -> helper appears BEFORE full app -> UAC ->
  accept = single elevated instance; decline = helper offers Launch normally / Close app;
  Close app terminates the process and tray entry (Task Manager verified).
- check-types, lint, test, cargo clippy/test, build all green; gen:bindings run.

BOUNDARIES
- You own the elevation/close/quit surface. Do NOT touch tray menu labels (A18), hotkey
  handling (A21), or the pill (A17/A13/A04/A22/A23).
```

---

## Agent A04 — Assistant-mode mini pill popout renders raw markdown

**Issue (verbatim):** "The assistant mode mini pill popout doesn't format/cleanup the llms visual output, but raw md"

**Grounded context (verified):**
- The assistant popout is drawn by the native pill crates: `packages/rust_macos_pill/src/app.rs` receives `InMessage::AssistantState { messages, streaming, ... }` (~line 461) and `draw.rs` renders the assistant panel text directly (raw string drawing; no markdown processing in the pill).
- The app side formats chat messages with `react-markdown` + `remark-gfm` in `apps/desktop/src/components/chats/ChatMessageBubble.tsx` (line ~110) — an in-app precedent for rendered markdown, but the pill is native canvas/Cairo/Direct2D, so it cannot reuse react-markdown.
- Assistant state is pushed to the pill from TS: `apps/desktop/src/utils/assistant-mode.utils.ts`, the agent runner (`src/agents/run-agent.ts`, `agent-configs.ts`), and `src-tauri/src/platform/{macos,windows,linux}/overlay.rs` (`notify_assistant_state`).
- Rule: "Rust is the API, TypeScript is the Brain" — formatting/cleanup logic belongs in TS, not duplicated in three Rust renderers.

**Owns:** `assistant-mode.utils.ts` (+ a new markdown-to-plain/pill-format helper under `src/utils/`), the TS callers that push assistant messages to the pill, and (minimally) the pill `draw.rs`/`gfx.rs` text-layout only if line wrapping of the formatted text needs support. NOT `ChatMessageBubble.tsx`.

```markdown
[Agent A04 — Assistant pill popout must not show raw markdown]

MISSION
The assistant-mode pill popout must display the LLM's output cleaned and formatted for the
pill surface (no `**bold**`, `### headers`, ```fences```, `-` bullets, raw links), on all
three platforms, while the in-app chat (ChatMessageBubble) keeps its existing rich markdown
rendering unchanged.

GROUND TRUTH
- Pill receives InMessage::AssistantState { messages, streaming, ... } (rust_macos_pill
  app.rs ~461; mirrors exist in windows/gtk pills) and draw.rs renders message text raw.
- ChatMessageBubble.tsx uses react-markdown + remarkGfm — webview only.
- TS pushes assistant state via assistant-mode.utils.ts / run-agent.ts / OverlaySyncSideEffects.
- The pill has no markdown engine; adding a full parser to three Rust renderers violates
  "TS is the brain" and DRY.

WALK (end to end)
1. Reproduce on at least one platform: open assistant mode, run an agent turn that returns
   markdown (headers, bold, lists, code fences, links), and capture the pill's raw output.
2. Implement a pure TS pipeline in your own util (e.g. src/utils/assistant-pill-text.utils.ts):
   - Strip/convert markdown constructs to pill-friendly plain text: headings -> sentence
     case text, bold/italic markers removed, inline code -> quoted text, fenced code ->
     readable block (e.g. with a light "code" prefix or indentation), lists -> "• " / "- ",
     links -> "text (url)" only when short, tables -> line rows. No emoji soup, no raw
     artifacts like `&#x27;`.
   - Handle STREAMING: the converter must be stable for partial output (never emit a
     half-rendered fence or dangling bullet; convert greedily but idempotently so each
     streaming chunk renders consistently).
   - Keep the raw text for the webview chat untouched (the pill gets the cleaned copy).
3. Wire the converter at the single choke point where assistant messages leave TS for the
   pill (assistant-mode.utils.ts / notify_assistant_state call sites). Ensure the pill's
   compact vs expanded panel modes and the conversation-id/user-prompt fields still work.
4. If the pill's text layout cannot wrap the cleaned text correctly (long lines), add
   minimal word-wrap support to the shared pill text-layout helpers — do NOT add markdown
   parsing to Rust.
5. Verify on all three pills (macOS/dev:mac, windows/dev:windows, linux/dev:linux if
   available in CI) with a fixed markdown sample.

REQUIREMENTS
- Raw markdown must never be visible in the pill again, including mid-stream states.
- No user-visible behavior change in the main window chat.
- Conversion must be locale-independent (no hardcoded English except universal symbols).

TESTS
- Unit tests for the converter: exhaustive markdown sample -> expected plain output;
  streaming stability property (output at chunk N must equal output of full text truncated
  at the same boundary, or be a documented safe partial); empty/null input; very long text.
- Update/extend any existing assistant-mode utils tests (src/utils/assistant-mode.utils.ts
  and test conventions in src/utils/__tests__).

I18N
- If you add any new pill-visible labels (e.g. "Code:"), they must be translated: check how
  pill strings are localized today (the pill receives localized strings from TS) and route
  through that channel; run pnpm --filter desktop i18n if you add TS strings.

DEFINITION OF DONE
- Assistant pill shows clean, formatted output for a markdown-heavy agent response on all
  platforms, stable while streaming; chat window unchanged.
- check-types, lint, test, cargo build for touched pill crates green.

BOUNDARIES
- Do not modify ChatMessageBubble.tsx or the webview rendering. You are wave 4 for the pill
  draw files — consume A17/A13's changes, do not rewrite their sections.
```

---

## Agent A05 — Dark-mode selected outline on provider/config cards

**Issue (verbatim):** "In darkmode, the selected outline state in boxes like [Personal Deepgram card HTML] is not visible due to being the same dark colour of the bg, wheras lightmode displays it perfectly."

**Grounded context (verified):**
- The card in the snippet is `ApiKeyCard` in `apps/desktop/src/components/settings/ApiKeyList.tsx` (~line 585): `borderColor: selected ? "primary.main" : "divider"`, `boxShadow: selected ? 0 0 0 1px primary.main : "none"`, `:hover` uses `action.active`.
- `AITranscriptionConfiguration.tsx` has the same pattern for local model rows (`borderColor: active ? "primary.main" : "divider"`, ~line 717) and download rows.
- `src/theme.ts` defines a dark-mode-aware focus outline via `accent.dark` (~line 203) — an existing precedent for theme-aware emphasis colors. The theme's palette makes `primary.main` too close to the dark background, so a primary-colored 1px outline is invisible in dark mode.

**Owns:** `ApiKeyList.tsx`, `AITranscriptionConfiguration.tsx` (card selection styling only). You may add a NEW exported selection-outline helper to `src/styles/` (new file, e.g. `selection.ts`), but do NOT edit `shadows.ts` or `theme.ts` (A14/A16 own them) — consume their exports instead.

```markdown
[Agent A05 — Visible selected outline on cards in dark mode]

MISSION
Make the "selected" state of provider/API-key cards and model rows clearly visible in dark
mode (and equally crisp in light mode), using the app's existing design tokens.

GROUND TRUTH
- ApiKeyList.tsx ApiKeyCard (~line 585): borderColor selected? "primary.main" : "divider";
  boxShadow selected ? `0 0 0 1px ${theme.palette.primary.main}` : "none".
- AITranscriptionConfiguration.tsx (~line 717 and download rows): borderColor
  active ? "primary.main" : "divider".
- theme.ts already has a dark-aware accent token pattern (accent.dark for :focus-visible).
- The app styles selected surfaces via premiumSurface.*.selected in styles/shadows.ts (do
  not edit; consume).

WALK (end to end)
1. Reproduce: settings -> AI transcription/AI post-processing/agent mode provider lists in
   dark mode; select a card (e.g. Personal Deepgram) and confirm the outline is invisible
   or barely visible; confirm light mode is fine. Screenshot both.
2. Find the root cause in the palette: inspect what primary.main resolves to in dark mode
   vs the card background (theme.ts + styles/palette.ts). The fix is a theme-aware selected
   treatment, not a one-off color.
3. Implement ONE shared selected-outline style (new src/styles/selection.ts or similar)
   consumed by every selected-card pattern in your two files. It must:
   - be visible on the card background in BOTH modes (light: dark/primary stroke;
     dark: light/accent stroke with sufficient contrast, e.g. the accent.dark token or a
     light `highlight`-based stroke + subtle outer glow);
   - include the 0 0 0 1px ring so the outline stays crisp when the card also has a border;
   - respect hover (selected hover must not revert to an invisible state);
   - keep focus-visible keyboard affordance (theme.ts :focus-visible already handles it —
     do not duplicate, just don't break it).
4. Apply it everywhere in your files that signals a selected card/row (ApiKeyCard, model
   rows, download rows, any other active-border pattern in those two files).
5. Sweep for the same pattern elsewhere (grep `borderColor: .*primary.main` and
   `0 0 0 1px`) — if you find more instances in files you do NOT own, list them as
   out-of-lane findings with file:line instead of editing.

REQUIREMENTS
- Contrast: the selected outline must be unmistakable at a glance in dark mode while not
  shouting in light mode. Verify against WCAG-ish non-text contrast (>= 3:1 vs card bg).
- No new hardcoded colors; derive from existing palette/accent tokens.

TESTS
- If you build a pure helper (e.g. selectedOutline(mode) -> style), unit-test it for both
  modes (assert it uses the dark-aware token in dark mode).
- Component test where the existing test setup allows: render ApiKeyCard selected in a dark
  ThemeProvider and assert the computed style differs from light mode and is not the raw
  primary color (keep it pragmatic — a shallow test of the style object is fine).

I18N
- No string changes expected.

DEFINITION OF DONE
- Selected card state clearly visible in dark AND light mode across the provider lists and
  model rows; hover on a selected card remains correct.
- check-types, lint, test green.

BOUNDARIES
- Do not edit theme.ts, shadows.ts (A14/A16), or any component outside your two files.
```

---

## Agent A06 — Dev-mode surfaces only in pre-release/CI builds

**Issue (verbatim):** "The dev mode(right click/inspect/devtools availability + top right window size output when resizing should only be available in pre-release/ ci build output)"

**Grounded context (verified):**
- DevTools opening is gated by env var `MAUSVOICE_ENABLE_DEVTOOLS` in `src-tauri/src/app.rs` (~line 281) — but the Tauri crate is built with the `devtools` feature unconditionally (`src-tauri/Cargo.toml` line 22: `tauri = { version = "=2.10.3", features = [..., "devtools", ...] }`), which also enables right-click inspect/DevTools availability in debug builds.
- Flavor system exists: `src-tauri/src/flavor_env.rs` loads `.env.{dev,prod,enterprise,...}` by `FLAVOR`/`VITE_FLAVOR`; frontend has `getFlavor()`/`isDev()`/`isProd()` in `src/utils/env.utils.ts`; build flavors driven by `apps/desktop/scripts/run-vite-with-flavor.mjs`.
- There are multiple Tauri configs: `src-tauri/tauri.conf.json`, `tauri.dev.conf.json`, `tauri.local.conf.json`, `tauri.prod.conf.json`.
- The "top right window size output when resizing" element was NOT found in the TS source at triage time — it may be a dev-only overlay rendered conditionally, injected by a dev script, or part of a debug surface in the pill/window chrome. **Locating it is part of your investigation** (search: components/root/*, getFlavor()/import.meta.env.DEV usages, devtools-injected overlays, the pill crates' window-size debug text — rust pill app.rs mentions "window size" in an animation comment).

**Owns:** `src-tauri/Cargo.toml` (tauri feature flags), `app.rs` (devtools gating block), `tauri.*.conf.json`, `scripts/run-vite-with-flavor.mjs`, the component/file you identify that renders the window-size output, CI workflows (`.github/`, `scripts/ci/`) only as needed to define the "CI build" gate.

```markdown
[Agent A06 — Gate dev surfaces to pre-release/CI builds]

MISSION
Right-click/inspect (DevTools) availability and the top-right window-size readout must be
present ONLY in pre-release/CI build output. End users of release builds must have no
devtools, no inspect menu, and no debug readout.

GROUND TRUTH
- app.rs ~281: MAUSVOICE_ENABLE_DEVTOOLS opens devtools at startup.
- Cargo.toml line 22: tauri "devtools" feature always on.
- Flavor/env machinery: flavor_env.rs, .env.dev/.env.prod/.env.enterprise*, env.utils.ts
  (getFlavor/isDev/isProd), run-vite-with-flavor.mjs, turbo globalEnv.
- Multiple tauri configs: tauri.conf.json / tauri.dev.conf.json / tauri.local.conf.json /
  tauri.prod.conf.json.
- The window-size readout was not located during triage; find it first.

WALK (end to end)
1. Inventory EVERY dev surface: (a) right-click context menu "Inspect" (WebView2/WKWebView
   devtools menu), (b) MAUSVOICE_ENABLE_DEVTOOLS startup devtools, (c) the top-right window
   size output (locate: search dev-only conditionals across components/root, index.html
   scripts, pill crates, and dev scripts; check what runs only in `pnpm --filter desktop
   dev:*`). Also check F12/Ctrl+Shift+I key routes if any are wired.
2. Define the gate precisely, document it in the plan, and implement it consistently:
   - Release builds (tauri.prod.conf.json, FLAVOR=prod): devtools feature OFF at compile
     time (make the Cargo `devtools` feature conditional on a cargo feature/build profile
     you introduce, e.g. a `debug-assist` feature enabled only in dev/profile prerelease
     CI builds), env-var devtools disabled, readout absent.
   - Pre-release/CI builds: keep devtools available for QA (define which flavor(s) count as
     prerelease: enterprise-dev/dev/local configs + CI debug artifacts).
   - The right-click inspect menu must be unavailable in release even if someone sets
     MAUSVOICE_ENABLE_DEVTOOLS=1 (compile-time removal, not runtime check only).
3. Wire the window-size readout to the same gate (render nothing in release; keep it for
   prerelease/CI). If it turns out to be an artifact of devtools itself, document that and
   ensure the compile-time gate covers it.
4. Update CI so a "prerelease" artifact type exists and is the ONLY artifact with dev
   surfaces (check .github/workflows and scripts/ci for how artifacts are produced today;
   do not redesign the release pipeline — only add the gate).
5. Verify: build a release artifact and a prerelease artifact; in release, right-click shows
   no Inspect, MAUSVOICE_ENABLE_DEVTOOLS is a no-op, and no size readout appears while
   resizing; in prerelease, devtools work as today.

REQUIREMENTS
- Security posture: no way for an end user to re-enable inspect in release (compile-time
  off). Do not weaken CSP or add unsafe-eval to work around anything.
- The app's normal resize behavior (WindowResizeHandles) is unaffected.

TESTS
- Extend startup-elevation-style source tests if useful (e.g. assert the release Cargo
  feature set excludes devtools) — prefer testing whatever you can at the config level and
  manual/CI matrix for the rest; document the manual matrix in the report.
- If you add a TS gate helper (e.g. isPrereleaseBuild()), unit-test it.

I18N
- No strings expected.

DEFINITION OF DONE
- Release artifact: no inspect/devtools/readout. Prerelease artifact: all three available.
- Matrix documented and verified on the platform(s) you can run; CI config updated.

BOUNDARIES
- Do not touch tray (A18), elevation flow (A03 — you are BEFORE them on app.rs), or the
  hotkey/bridge system.
```

---

## Agent A07 — Slider thumb dips on hover

**Issue (verbatim):** "The slider's head visual goes down on hover" (dictation audio dim slider: MUI Slider with valueLabel, `aria-label="Dictation audio dim level"`).

**Grounded context (verified):**
- The slider is `ElasticSlider` in `apps/desktop/src/components/common/ElasticSlider.tsx` (wraps MUI Slider; sx overrides for rail/track/thumb at ~lines 106-120+), used by `AudioDialog.tsx` for "Dictation audio dim level" (min 0, max 1, step 0.05, commit-on-release).
- `theme.ts` has NO MuiSlider overrides (verified) — the hover dip must come from ElasticSlider's own sx (likely a `:hover`/`:active` transform like `translateY` or a thumb size change that shifts its visual center downward), or from MUI's default hover behavior interacting with ElasticSlider's custom thumb geometry.

**Owns:** `ElasticSlider.tsx` (+ `AudioDialog.tsx` only if the fix requires prop adjustments).

```markdown
[Agent A07 — Slider thumb must not sink on hover]

MISSION
The slider thumb must stay vertically stable on hover/focus/drag across light and dark
modes, for every slider built on ElasticSlider, without changing the intended elasticity
feel or the commit-on-release behavior.

GROUND TRUTH
- ElasticSlider.tsx: MUI Slider wrapper, custom sx on rail/track/thumb (~line 106+).
- AudioDialog.tsx: <ElasticSlider ... ariaLabel="Dictation audio dim level" />.
- theme.ts has no MuiSlider overrides (verified) — fix belongs in ElasticSlider, not theme.

WALK (end to end)
1. Reproduce in AudioDialog: hover the thumb; confirm the thumb visually translates
   downward (and check whether focus or dragging also dips it). Measure the delta in
   DevTools (computed transform of .MuiSlider-thumb on :hover).
2. Find the offending rule (candidates: hover transform translateY, thumb size change with
   an anchor that is top-left instead of center, margin/padding change, or MUI's default
   `:hover` box-shadow growth shifting the visual mass). Fix the root: keep the thumb's
   geometric center constant (use scale about center for any grow effect; no translateY;
   or explicitly counter the offset).
3. Check ALL states: default, hover, focus-visible (keyboard), active/dragging, disabled,
  and the valueLabel visibility while dragging. Also verify the label bubble (0.6 chip)
  tracks the thumb and does not clip at min/max ends.
4. Verify every other ElasticSlider consumer (grep <ElasticSlider) still behaves.
5. If the root cause turns out to be a MUI default override you must neutralize globally,
  you MAY add a scoped MuiSlider styleOverrides block in theme.ts — but ONLY a minimal,
  documented one; A14/A16 come after you and must not conflict (leave a comment-free,
  conventional override and list it in your report).

REQUIREMENTS
- No visual regressions on rail/track/thumb proportions or the elastic release animation.
- prefers-reduced-motion still respected.

TESTS
- If the fix is a pure style-object change, add a test asserting the thumb sx contains no
  vertical translation on hover (and contains the chosen stable transform). Keep it a real
  assertion, not a tautology.

I18N
- No strings.

DEFINITION OF DONE
- Thumb center does not move on hover in light/dark mode; drag and keyboard flows intact.
- check-types, lint, test green.

BOUNDARIES
- Do not redesign slider visuals (that is A16's shadow work — they follow you on theme.ts).
```

---

## Agent A08 — Dictation clipboard backlog & no more "copied to clipboard" spam

**Issue (verbatim):** "When a user clicks or activates the pill to start detecting dictation and real-time output is enabled, if the user has not directly clicked an input, the pill should not display transcription copied to clipboard continously. Instead, wait until the user clicks an input, then paste the backlog, all of it if the button or timer output is being activated. Also, instead of always spamming 'transcription copy to clipboard', wait until the transcription is completed or until the user enters an inputable area, then paste it and continue what the user is saying."

**Grounded context (verified):**
- Output routing: `src/utils/output-routing.utils.ts` — `routeTranscriptOutput()` → `insertLocalTranscriptOutputViaPaste()` → Tauri `paste` command; when the focused element is NOT editable the command returns `"copied_to_clipboard"` and the code flashes "Transcript copied to clipboard" on the pill (`sendPillFlashMessage`) — this is the spam source.
- Real-time pipeline lives in `src/components/root/DictationSideEffects.tsx` (1319 lines): recording sessions, phases, finalize, post-processing; real-time segments route through output routing repeatedly while the user speaks.
- State: `src/state/app.state.ts` (overlayPhase, audioLevels, hotkeyTriggers, keysHeld), `settings.state.ts` (real-time output prefs), toast system `src/actions/toast.actions.ts` + `SnackbarEmitter.tsx`.
- The Rust `paste` command is in `src-tauri/src/commands.rs` (returns a discriminated outcome string) — the editable-target probe lives there.

**Owns:** `output-routing.utils.ts`, the real-time routing section of `DictationSideEffects.tsx` (you are FIRST on this file; A09/A22/A21 come after you and must be left clean seams), `app.state.ts` (new backlog state), `toast.actions.ts` if a completion toast is added, `commands.rs` only if the Rust paste command needs a richer probe result (coordinate with A03/A18 ordering — you are between them on commands.rs).

```markdown
[Agent A08 — Backlog-and-paste model for dictation output]

MISSION
Replace "paste-every-segment-now, fall back to clipboard per segment" with a backlog model:
- While dictation is active and real-time output is on, accumulate segments.
- If a focused element is editable, paste into it (live continuation as today).
- If NOT editable, do nothing visible: no per-segment clipboard write, no repeated pill
  flash. Hold the backlog.
- On the FIRST of: user focuses/clicks an editable input, OR the transcription completes
  (stop/pause/finalize, including button and timer activation paths) — deliver the ENTIRE
  backlog once (paste if an editable target exists; single clipboard write + single
  "Transcript copied to clipboard" pill flash only if there is still no editable target).
- After backlog delivery, dictation continues normally ("continue what the user is saying").

GROUND TRUTH
- output-routing.utils.ts routeTranscriptOutput / insertLocalTranscriptOutputViaPaste is
  the current per-call path; "copied_to_clipboard" outcome flashes the pill each time.
- DictationSideEffects.tsx drives real-time segments and finalize; the paste outcome comes
  from the Rust `paste` command (commands.rs) which already distinguishes editable targets.
- Pill flash helper: sendPillFlashMessage in src/utils/overlay.utils.ts.
- Real-time output pref + button/timer activation modes exist in settings/app state — trace
  exactly how "real-time output" and button/timer modes flow through DictationSideEffects.

WALK (end to end)
1. Map the current pipeline precisely (read DictationSideEffects + output-routing):
   where real-time segments are produced, where finalize happens, which paths call
   routeTranscriptOutput, and where the button/timer modes differ.
2. Design the backlog state (Zustand + Immer, in app.state.ts or a dedicated slice):
   pendingBacklog: string[], backlogDelivered flag per session, lastOutcome state.
   Keep it per dictation session (cleared on start; never carried across sessions).
3. Implement routing policy:
   - editable target present: paste immediately (existing behavior), clear backlog on
     success.
   - no editable target: append to backlog; do NOT write clipboard; do NOT flash pill.
   - focus-in on an editable element (window focus/blur + a lightweight target probe —
     decide the detection channel: existing `paste` probe on a throttle, or a
     focus/selectionchange listener; prefer the least invasive, most reliable one):
     drain backlog once via paste; if paste fails, single clipboard fallback + single flash.
   - completion (finalize/stop/timer/button): drain backlog once with the same rule.
4. Preserve remote-output mode (deliverRemoteOutput) and review-before-insert flows — the
   backlog model must compose with both; decide and document where review applies to the
   backlog (per-segment today vs whole-backlog once — keep today's semantics unless the
   issue implies otherwise).
5. Sanitization: backlog items must go through the same sanitizeIndentation path on
   delivery, not on append (avoid double-processing).
6. Update the Rust `paste` command ONLY if you need a richer outcome (e.g. "editable target
   currently focused" vs "paste succeeded"); prefer keeping its contract and probing from
   TS with the existing command. Any signature change => pnpm gen:bindings.
7. Guard against races: a segment arriving WHILE the backlog is draining; two sessions
   overlapping; window blur during drain. Use the repo's session/generation-counter idioms.

REQUIREMENTS
- Zero "Transcript copied to clipboard" spam during dictation with no editable focus.
- At most ONE clipboard write + ONE pill flash per delivery event.
- Real-time into a focused input keeps working with the same latency profile.
- Button and timer activation paths deliver the full backlog as specified.

TESTS
- Unit tests for the new routing policy (extract it into a pure decision function taking
  (hasEditableTarget, isComplete, backlog, ...) -> action) covering: editable live path,
  backlog accumulation, focus-then-drain, completion-drain, empty backlog, remote mode,
  review mode, double-drain race.
- Extend existing output-routing tests if present (src/utils/__tests__).

I18N
- If the single completion flash/toast wording changes, use FormattedMessage defaultMessage;
  run pnpm --filter desktop i18n. (A19 owns the copy sweep — keep wording unless required.)

DEFINITION OF DONE
- Repro: start dictation with real-time output, focus nothing editable, speak for 30s:
  no clipboard writes and no pill flashes during that time; click an input: entire backlog
  pastes once; repeat for completion path and button/timer modes.
- check-types, lint, test green; gen:bindings run if any command changed.

BOUNDARIES
- You are first on DictationSideEffects.tsx. Leave named helpers and clear seams; do not
  touch tone/style switching (A09/A22), hotkey handling (A21), or pill Rust code.
```

---

## Agent A09 — "Switch style while dictating" uses the old profile

**Issue (verbatim):** "Additionally, if the 'switch style while dictating' option is on, there is a bug: when you start dictating and then switch, the final dictated output still uses the profile that was in use before clicking. I'm not sure if this also applies with the shortcut keys and left/right arrow application, but check that afterward."

**Grounded context (verified):**
- `DictationSideEffects.tsx`: `segmentStartToneIdRef` (~line 156) is captured at segment start (~line 760); `finalizeAndPostProcess` (~line 532) retags with `segmentStartToneIdRef.current` in manual mode with an explicit comment that a mid-utterance style switch must NOT relabel an already-spoken segment. This is exactly the reported bug: the switch is applied to the label but the final output is still post-processed/rendered with the pre-switch profile (verify whether the tone id used for the transcription request and post-processing is the stale one).
- Style switching paths: `tone.actions.ts` (`cycleWritingStyle`, `selectToneByHotkey`, switchWritingStyleForward/Backward), hotkey combos via `DictationSideEffects` (`DICTATE_HOTKEY` + Left/Right whitelist, ~line 949+), the pill's `StyleSwitch { direction }` IPC (`packages/rust_*_pill/src/ipc.rs` OutMessage), and `notify_pill_style_info` (~line 1312).
- The preference is `inDictationStyleSwitchingEnabled` (persisted; `preferences_queries.rs`, `user.actions.ts` setInDictationStyleSwitchingEnabled).
- Manual vs automatic styling modes: `getEffectiveStylingMode` / `getToneIdToUse`.

**Owns:** the style-switch semantics in `DictationSideEffects.tsx` (you are SECOND on this file, after A08) and `tone.actions.ts` (first on it; A22 follows you). Pill Rust is A22's lane — you consume its IPC, you don't change it.

```markdown
[Agent A09 — Mid-dictation style switch must apply to the final output]

MISSION
When "switch style while dictating" is enabled, switching styles mid-utterance must produce
final output in the NEWLY selected profile — for every switch channel: pill top style
selector, style hotkeys, and Left/Right arrow keys while holding the dictate key. Define
and test the exact semantics (what happens to already-finalized segments vs the current one).

GROUND TRUTH
- finalizeAndPostProcess (~line 532) retags with segmentStartToneIdRef in manual mode —
  the comment says this is intentional for labeling, but the BUG is that the final output
  still uses the pre-switch profile. Verify precisely WHERE the stale tone is used:
  the transcription request itself, the post-processing call, or both.
- segmentStartToneIdRef is set ~line 760 at segment start.
- Switch channels: cycleWritingStyle/selectToneByHotkey (tone.actions.ts),
  DICTATE_HOTKEY + Left/Right (DictationSideEffects ~949+), pill StyleSwitch IPC.
- Modes: manual styling (user switches) vs automatic (app-target based, captured at stop).

WALK (end to end)
1. Reproduce with instrumentation: enable the option; start dictating; switch style
   mid-utterance via (a) the pill selector, (b) a style hotkey, (c) Left/Right while
   holding the dictate key; stop; compare the final output's style markers/post-processing
   against the selected profile. Capture which channels work and which don't.
2. Trace the data flow for each channel: switch -> tone state update -> what the
   transcription/finalize path reads -> what post-processing receives. Identify whether
   channels disagree (e.g. pill switch updates UI state but not the tone id used by
   finalize; or hotkeys update state but segmentStartToneIdRef isn't refreshed).
3. Define semantics (document in your report; keep it simple and predictable):
   - The tone id used for the FINAL output must be the tone selected at STOP time for
     the current utterance (manual mode), i.e. a mid-utterance switch takes effect for
     the output being produced, not just the label.
   - Decide the boundary: if the style is switched WHILE a real-time segment is already
     streaming, does the switch apply from the next segment only (recommended: yes,
     atomic per segment — never re-style already-inserted text) or retroactively to the
     whole utterance? Pick the option that matches user expectation ("the final dictated
     output still uses the profile in use before clicking" must be fixed) and document it.
   - Automatic mode must remain unaffected (app-target tone captured at stop).
4. Implement in tone.actions.ts + DictationSideEffects.tsx: refresh the effective tone at
   the right lifecycle points; make sure the pill's displayed style name (notify_pill_style_info)
   and the actual applied tone can never drift apart.
5. Verify Left/Right arrow channel specifically (the note calls it out) and the shortcut
   keys channel; fix any channel that bypasses the common path (a channel that writes a
   different state slot is a root-cause candidate for the bug).
6. Update the comment at finalizeAndPostProcess if its documented intent changes — the
   comment must match the new behavior.

REQUIREMENTS
- All three switch channels behave identically (one shared state transition).
- No re-styling of text already inserted; no double post-processing of a segment.
- The switch must be race-safe with stop/finalize (a switch arriving during finalize must
  resolve deterministically — document which wins).

TESTS
- Unit-test a pure "effective tone at finalize" helper: switch before stop, switch during
  real-time segment, switch after stop, automatic mode.
- Extend any existing DictationSideEffects tests; add a test that all three channels call
  the same state transition.
- If the pill IPC payload is involved, test the TS handler with a mocked invoke.

I18N
- No new strings expected.

DEFINITION OF DONE
- Repro matrix (pill selector / hotkey / arrows) shows final output matches the newly
  selected profile in manual mode; automatic mode unchanged.
- check-types, lint, test green.

BOUNDARIES
- You are after A08 on DictationSideEffects.tsx and before A22 (pill selector) and A21
  (hotkeys). Do not modify pill Rust code (A22 owns the IPC sender).
```

---

## Agent A10 — Retranscribe: loading animation/toast + completed state/toast

**Issue (verbatim):** "There is no loading animation / toast and completed state/toast for the retranscribe button" (the refresh icon button on transcription rows).

**Grounded context (verified):**
- `apps/desktop/src/components/transcriptions/TranscriptRow.tsx`: `isRetranscribing` per row (~line 61) drives only a tooltip (`retranscribeTooltip`) on the button (~line 257) — no spinner, no visual in-flight state.
- `apps/desktop/src/components/transcriptions/RetranscribeDialog.tsx`: `handleSubmit` sets `retranscribingIds`, calls `retranscribeTranscription`, on success pushes `retranscriptionSuccessIds` (auto-cleared after `SUCCESS_VISIBLE_DELAY_MS = 900`) — but there is no success toast/snackbar, and the row button does not reflect the completed state beyond state that no one visibly renders.
- Toast infrastructure exists: `src/actions/toast.actions.ts` + `src/components/root/SnackbarEmitter.tsx`; error path already uses `showErrorSnackbar` from `src/actions/app.actions.ts`.
- Action/repo: `src/actions/transcriptions.actions.ts` (`retranscribeTranscription`), state `src/state/transcriptions.state.ts` (`retranscribingIds`, `retranscriptionSuccessIds`, `retranscribeDialogOpen`).

**Owns:** `TranscriptRow.tsx` (exclusively), `RetranscribeDialog.tsx` (first; A15 follows), `transcriptions.actions.ts`, `transcriptions.state.ts`, `toast.actions.ts` (additive only).

```markdown
[Agent A10 — Retranscribe loading + completion feedback]

MISSION
Give the retranscribe flow full feedback at every step:
- In-flight: a visible loading state on the row button (spinner replacing/pulsing the icon,
  disabled while running, clear aria-busy), plus a loading toast/indicator when triggered
  from the dialog.
- Success: a completion toast (e.g. "Retranscription complete") AND a transient completed
  state on the row button (checkmark or flash) so the user sees which row finished.
- Failure: keep the existing error snackbar, and make the row recover cleanly.
- All states must be screen-reader friendly and consistent with the app's existing
  snackbar/dialog patterns.

GROUND TRUTH
- TranscriptRow.tsx ~61: isRetranscribing -> tooltip only; ~257 the button.
- RetranscribeDialog.tsx: retranscribingIds/retranscriptionSuccessIds lifecycle exists but
  has no visible success surface; SUCCESS_VISIBLE_DELAY_MS = 900.
- toast.actions.ts + SnackbarEmitter.tsx are the app's toast channels; showErrorSnackbar
  is the error precedent.
- transcriptions.state.ts holds retranscribingIds / retranscriptionSuccessIds.

WALK (end to end)
1. Reproduce: retranscribe a row from the row button and from the dialog; note the only
   feedback today (button tooltip, dialog closes) and the absence of success feedback.
2. Design the state->UI mapping (keep state where it is, add rendering):
   - Row button: spinner (MUI CircularProgress size matching icon) + disabled while
     isRetranscribing; completed check (CheckRounded or similar) while the row id is in
     retranscriptionSuccessIds; tooltip text updated per state (in-flight / done).
   - Toasts: on dialog submit or row trigger, show a persistent-in-flight toast
     (loading spinner, non-dismissible while running) and replace it with a success toast
     on completion. Use the toast.actions API — extend it only if a loading toast type
     does not exist.
3. Reuse the existing successIds timer semantics or replace them with toast-driven
   semantics — pick ONE owner of the "completed" signal so the row checkmark and the toast
   cannot disagree. Ensure rapid successive retranscribes (same row twice, two rows in
   parallel) do not clear each other's state early (the current setTimeout clear is a
   candidate race — check it).
4. Keep dialog behavior (close on submit) but the in-flight toast must continue after the
   dialog closes, since retranscription runs in the background.
5. Verify on History page AND Home page (Home renders TranscriptionRow for recent items) —
   both must show the new states.

REQUIREMENTS
- No duplicate toasts when a row triggers from two surfaces; idempotent completion signals.
- Buttons must not be clickable while in-flight (prevents double submission).
- prefers-reduced-motion: spinner still indicates progress without pulsing animation.

TESTS
- Unit tests for the state transitions (in-flight -> success -> cleared; error path keeps
  row enabled) if a pure helper can be extracted.
- Component test where conventions allow: TranscriptRow renders spinner while
  retranscribingIds contains the row id, checkmark while successIds contains it.

I18N
- New strings (loading/completed tooltips, toasts) via FormattedMessage defaultMessage /
  useIntl; run pnpm --filter desktop i18n.

DEFINITION OF DONE
- Loading spinner + disabled state, completion checkmark, loading toast, success toast, and
  error recovery all verified by hand on History and Home; double-click protection works.
- check-types, lint, test green.

BOUNDARIES
- Do not edit other row components (A15 will touch the dialog's style select afterwards).
```

---

## Agent A11 — Custom native-feeling right-click context menu

**Issue (verbatim):** "Custom native feeling right click menu, with contextual items"

**Grounded context (verified):**
- There is NO app-wide context menu today: only scattered local `preventDefault()` handlers (e.g. `ConversationLayout.tsx:173`, `EditTypography.tsx`, `ListTile.tsx:145`). Right-click currently yields the default webview menu (or devtools menu in dev — see A06).
- Existing menu-building precedent: `src/components/common/MenuPopover.tsx` (`MenuPopoverBuilder`, `MenuPopoverItem`, anchored popovers used in the header) and MUI Menus throughout settings.
- The app is a desktop Tauri app on macOS/Windows/Linux; a "native feeling" menu must follow per-platform conventions (position at cursor, correct item order, accelerator display hints, submenus, close on scroll/Escape/blur).
- Contextual targets to serve (enumerate in your investigation): transcriptions (copy text, copy ID, retranscribe, delete, open details, tone menu), dictionary rows (edit, delete), chats (copy message, new chat, delete conversation), styles rows (edit, duplicate, delete), composer text (cut/copy/paste/select all, review), inputs (native-ish clipboard items), home (refresh), plus generic app items.

**Owns:** a NEW shared component (`src/components/common/ContextMenu.tsx` or `NativeContextMenu.tsx`) plus per-page wiring. `MenuPopover.tsx` is shared infrastructure — if you must extend it, do so additively (do not break the header usage). `theme.ts`/`shadows.ts` are NOT yours.

```markdown
[Agent A11 — Native-feeling contextual right-click menu]

MISSION
Ship one reusable, custom-styled context-menu system with contextual items per surface,
feeling native on macOS/Windows/Linux: opens at cursor, keyboard-navigable, dark/light
themed, closes on scroll/resize/blur/Escape, and never shows the webview's default menu
in the app.

GROUND TRUTH
- No global contextmenu handling today; scattered preventDefault() call sites exist
  (ConversationLayout.tsx:173, EditTypography.tsx:105/108/194, ListTile.tsx:145).
- MenuPopover.tsx is the app's anchored-menu precedent (MenuPopoverItem with
  kind:"listItem", leading icons, onClick({close})).
- Tauri app, MUI v9 (v7+ APIs: slotProps, no deprecated Menu props).

WALK (end to end)
1. Inventory the surfaces and their contextual actions (grep each page component; list at
   least: History rows, Dictionary rows, Styles rows, Chats list + messages, Composer,
   Settings lists, Home, and a default app-level menu for empty areas). For each surface
   define the exact item list + order (platform-idiomatic: common verbs first, destructive
   verbs last with error color, separators between groups).
2. Design the component API (keep it close to MenuPopoverItem):
   <ContextMenu items={...} /> exposing an onContextMenu handler factory, OR a context
   provider at root that surfaces register their items into. Prefer a self-contained
   component per surface with a shared builder — avoid a global registry unless several
   surfaces need it.
3. Behavior spec (implement all):
   - opens at pointer position, clamped to viewport (flip/offset like a native menu);
   - single instance; right-click elsewhere closes and reopens at the new position;
   - closes on: click (with item action), scroll, window blur/resize, Escape, second
     right-click outside;
   - keyboard: opens on Shift+F10/ContextMenu key at focused element (native convention),
     ArrowUp/Down navigation, Enter to activate, Home/End, typed first letters optional;
   - focus management: menu takes focus while open, restores focus on close;
   - theming: uses the existing palette tokens; dark + light verified; matches MUI menu
     styling (radius, shadows) but with a custom chrome that reads "native" (compact
     density, accelerator hints like Ctrl+C displayed per platform);
   - submenus where needed (e.g. "Move style up/down" not required — keep scope to
     flat menus unless a surface truly needs nesting);
   - disabled states with reasons (e.g. Copy when nothing selected);
   - platform accelerators rendered as hints only (actual key handling stays with the
     app's hotkey system — do NOT re-implement global shortcuts).
4. Wire surfaces one at a time, starting with transcriptions/dictionary/styles/chats
   (highest value). Ensure existing local preventDefault() behaviors that should become
   menu items are consolidated into the new system (remove the scattered hacks you own;
   list others as findings).
5. Right-click on text inputs: preserve text-selection semantics — only suppress the
   default menu and offer at least Cut/Copy/Paste/Select All (executed via
   document.execCommand('copy') fallback or the existing clipboard utils).
6. Verify no conflict with A06's dev-mode gating (in release there must be no Inspect item
   anywhere; do not add one).

REQUIREMENTS
- Zero default webview context menus anywhere in the app.
- All menu strings i18n-ready from day one.
- No new dependencies.

TESTS
- Component tests: open at position, clamp near edges, item click calls action + closes,
  Escape/scroll/blur close, keyboard navigation, single-instance behavior, disabled items.
- A surface test per wired page (renders menu items for its context).

I18N
- Every item label via FormattedMessage/useIntl; run pnpm --filter desktop i18n.

DEFINITION OF DONE
- All inventory surfaces wired (or explicitly descoped with rationale in report); native
  feel verified on at least macOS + Windows; both themes; keyboard path works.
- check-types, lint, test green.

BOUNDARIES
- Do not modify MenuPopover consumers (header) behavior; do not touch theme.ts/shadows.ts.
- Report any surface you deliberately did not wire with a clear follow-up for A12.
```

---

## Agent A12 — Stability, memory-leak, and idle-memory hardening

**Issue (verbatim):** "Improve overall feeling of stability, reduce memory leak incidents, and idle memory usage"

**Grounded context (verified):**
- Known leak-risk areas in this checkout (from REVIEW.md and triage reading):
  * `ScrollListPage.tsx` — ResizeObserver + rAF + double effect ownership (A02 is already fixing this; coordinate, do not duplicate).
  * `TitleBar.tsx` — `onResized` listener; `WindowResizeHandles.tsx` per-pointer handlers.
  * `AppSideEffects.tsx` — many `useTauriListen` subscriptions + a Zustand subscription keyed on hotkey fingerprint; verify unsubscribe paths.
  * `DictationSideEffects.tsx` (1319 lines) — session timers, listeners, refs; verify teardown on unmount and on phase change.
  * `useAsyncEffect` / async hooks (`src/hooks/async.hooks.ts`) — unmount races; the repo review rules demand generation counters for stale callbacks.
  * Rust: `pill_process.rs` child processes, `rust_transcription` sidecar leases, `system/audio_feedback.rs` warm thread, windows webview keepalive (`platform/windows/window.rs`, `start_webview_keepalive`), `REVIEW.md` subprocess rules (unbounded `wait_with_output`, zombie leaks).
  * Pill crates: rAF/render loops, IPC readers, per-frame allocations (esp. windows D2D and macos Cairo paths).
- REVIEW.md documents the audit protocol (lifecycle, listener teardown, handle release, subprocess draining) — follow it.

**Owns:** an AUDIT + targeted-fix lane. You may fix only what you can PROVE leaks or wastes memory, in any file, but you must record every cross-lane finding instead of refactoring other agents' work. Prefer fixes in shared hooks (`async.hooks.ts`), listener helpers, and Rust lifecycle code you can test.

```markdown
[Agent A12 — Stability and memory hardening (audit + provable fixes)]

MISSION
Reduce memory-leak incidents and idle memory usage across the desktop app and the Rust
backend, measurably, without destabilizing anything: find leaks first, fix only provable
ones, file precise findings for everything else. Runs LAST (wave 4): all other agents'
fixes are in.

GROUND TRUTH
- REVIEW.md is your audit handbook (lifecycle checks, subprocess draining rules, test
  hygiene). Follow its protocol.
- Candidate leak sites enumerated in the plan (TitleBar onResized, AppSideEffects
  subscriptions, DictationSideEffects listeners/timers, async hooks, Rust subprocesses,
  audio thread, keepalive, pill render loops). Verify each; the list is not exhaustive.

WALK (end to end)
1. Build a measurement harness first (so every fix is evidence-backed):
   - Frontend: run the app, open/close each page and dialog N times; use Chrome DevTools
     Memory (heap snapshots, detached DOM nodes, event listeners count) via the
     prerelease build (A06's gate). Record baseline idle memory and growth-per-cycle.
   - Rust: instrument where cheap (log subprocess/thread counts at intervals) or use
     platform tools (Activity Monitor / Task Manager, macOS leaks, perf).
2. Audit in priority order: (a) unmount/subscription teardown in AppSideEffects and
   DictationSideEffects (any listener without unsubscribe, any effect with missing dep or
   stale-closure race); (b) async hooks — cancel/ignore stale resolutions (generation
   counters); (c) TitleBar resize listener; (d) Rust subprocess lifecycle (zombies, pipe
   draining per REVIEW.md), sidecar lease release, audio thread on exit; (e) pill crates:
   per-frame allocations in draw loops, IPC reader threads, exit paths.
3. Fix ONLY provable leaks/waste, in the smallest root-cause way, following repo rules
   (DRY, minimal impact). For each fix: before/after measurement in the report.
4. Everything you find but decide not to fix (risk, out-of-lane, needs design) goes into
   "Out-of-lane findings" with file:line, evidence, and a suggested fix — these are
   deliverables, not omissions.
5. Idle memory: identify what runs while the app is idle (keepalive timers, pollers,
   background refreshes, pre-warmed audio, transcription cache) and reduce provable waste
   (e.g. stop unused pollers, cap caches) without changing UX (instant resume must stay).
6. Finish with a stability checklist run: 30 cycles of open/close across the 6 main
   pages + dialogs, memory growth < documented threshold; no listener growth; process
   exits cleanly (no lingering sidecars/zombies).

REQUIREMENTS
- Fixes must not change user-visible behavior (except removing jank).
- Every fix lands with a regression test where testable (teardown tests, subscription
  counters, subprocess kill/reap tests per REVIEW.md patterns).
- Report format: Measurement harness setup / Baselines / Fixes (evidence each) /
  Remaining findings (filed for later) / Idle memory summary.

TESTS
- Teardown unit tests for anything you fix in hooks/side effects; Rust tests for
  subprocess/thread lifecycle per REVIEW.md examples.

I18N
- No strings.

DEFINITION OF DONE
- Documented before/after memory metrics for the top pages; zero known listener/observer
  leaks in audited components; clean process exit; idle memory measurably reduced.
- Full suite green (check-types, lint, test, cargo fmt/clippy/test, build).

BOUNDARIES
- You run after everyone: prefer handoff findings over touching files another agent owns
  (ScrollListPage/A02 unless they missed something — then report to them).
```

---

## Agent A13 — Shadow behind the silver long-press element

**Issue (verbatim):** "Add a shadow behind the silver long press element to improve visibility on light backdrops"

**Grounded context (verified):**
- The "silver" element is the pill's long-press grab affordance: `packages/rust_macos_pill/src/constants.rs` (~line 202) and the windows/gtk equivalents define the "Silver-white with a very slight cool tint" color used by the long-press ring/grab bar; geometry helpers live in `packages/rust_pill_shared/src/lib.rs` (rounded-rect perimeter, ring envelope math).
- Rendering: macOS/GTK use Cairo (`draw.rs`), Windows uses Direct2D (`gfx.rs`). There is no drop-shadow behind the silver element today.
- The three pill draw.rs files are the shared file lane: A17 (fonts/labels) runs before you; A04 (assistant panel) runs after you. Only touch the long-press element section.

**Owns:** long-press element rendering in all three pill crates (`draw.rs` sections + any color/constant you add in `constants.rs`), shared math in `rust_pill_shared` only if needed for identical cross-platform shadow geometry.

```markdown
[Agent A13 — Drop shadow behind the pill's silver long-press element]

MISSION
Render a soft drop shadow behind the silver long-press element on all three platforms so
it stays clearly visible on light/white backdrops, matching the app's premium shadow
language, with zero change to the element's geometry or animation timing.

GROUND TRUTH
- constants.rs ~line 202 (per-platform): silver-white grab color.
- rust_pill_shared/src/lib.rs: ring perimeter/envelope math shared by all renderers.
- macOS/GTK draw with Cairo; Windows with Direct2D (gfx.rs) — shadows must be
  implemented with each backend's primitives (Cairo: blur via multiple strokes or
  set_shadow; D2D: effect or layered strokes — check what the crates already use for
  edge gradients, draw_edge_gradient exists per-platform).

WALK (end to end)
1. Read each platform's long-press draw path and its existing edge-glow/gradient helpers.
   Understand how the "comet ring" is shaded today so the shadow enhances rather than
   fights it.
2. Implement the shadow in each backend: a soft dark halo behind the silver element,
   strongest at the element edge, fading within a few px, tuned for light backdrops
   (test over white, light gray, and a light wallpaper gradient). Keep alpha low enough
   that dark backdrops are unaffected.
3. Ensure the shadow: follows the pill's scale/expand animations (drawn in the same
   transformed space), respects the long-press progress (subtle at rest if visible at
   all, full during the hold), and does not add per-frame cost that regresses A12's
   idle/perf work (reuse existing geometry; no new high-frequency allocations).
4. Cross-platform parity: verify pixel-similar results on macOS and Windows (and GTK if
   you can run it); use rust_pill_shared for any shared shadow-radius constants so the
   three renderers cannot drift.
5. Verify the pill's idle, recording, and pause states still look correct on light AND
   dark wallpapers.

REQUIREMENTS
- No geometry or timing changes to the long-press interaction itself.
- No new dependencies; use backend-native drawing.
- Deterministic across platforms (shared constants where possible).

TESTS
- Extend existing rust_pill_shared unit tests if you add geometry helpers.
- Manual visual matrix (light/dark backdrop x 3 states) documented in the report.

I18N
- None.

DEFINITION OF DONE
- Silver element clearly visible on light backdrops on macOS + Windows (+ Linux if
  runnable), unchanged on dark; animations intact.
- cargo fmt/clippy/test green for touched crates.

BOUNDARIES
- You are after A17 on draw.rs and before A04: do not touch the idle label/animation or
  the assistant panel.
```

---

## Agent A14 — Light-mode inner shadow on buttons is too heavy

**Issue (verbatim):** "In light mode the inner shadow on buttons isn't light" (reads: the inset shadow on buttons in light mode looks wrong/heavy, unlike dark mode's refined inner highlight).

**Grounded context (verified):**
- `src/styles/shadows.ts` `premiumSurface.light.*` defines the inset highlights (2px inner top highlight via `highlight(alpha)`) + drop shadows used by MUI button overrides in `src/theme.ts` (e.g. `MuiButton`/`MuiListItemButton`/`MuiToggleButton` blocks, ~lines 420-495 and 300-320).
- `highlight`/`ink` helpers come from `src/styles/palette.ts`. Light-mode "inner shadow" = the `inset 0 1px/2px 0` lines. If those alphas are too strong (or the shadow uses `ink` instead of `highlight` in light), buttons look engraved rather than lightly embossed.
- A16 (later) will redesign/mirror the full light-mode shadow language — you own the BUTTON-level correction now; A16 builds on you.

**Owns:** `theme.ts` button-related overrides only (MuiButton, MuiListItemButton, MuiToggleButton blocks), `shadows.ts` (first owner; A16 follows — leave clean token structure).

```markdown
[Agent A14 — Light-mode button inner shadow correction]

MISSION
Make light-mode buttons carry a light, crisp inner highlight (subtle top emboss) instead
of the current heavy/dark inner shadow, matching the design language dark mode already
has, without changing dark mode.

GROUND TRUTH
- premiumSurface.light.rest/hover/active/selected in shadows.ts drive button surfaces via
  theme.ts overrides (MuiButton ~420-495, MuiListItemButton ~300-320, ToggleButton).
- palette.ts exports highlight(alpha)/ink(alpha)/darkInk(alpha).
- Dark mode reads "refined" per the issue; light mode currently does not.

WALK (end to end)
1. Reproduce: light mode, inspect a contained button and a list-item button; screenshot
   the inner shadow. Identify exactly which inset stop(s) look wrong (likely the 2px
   inset highlight alphas, or an inset using ink() where highlight() belongs).
2. Compare with dark mode's equivalents and with the design docs (apps/desktop/DESIGN.md)
   to derive the intended light treatment.
3. Fix at the token level: adjust premiumSurface.light.* inset alphas (and any ink-vs-
   highlight misuse) so the inner shadow reads as a light emboss. Keep the drop-shadow
   stops unchanged (A16 will evolve those).
4. Audit every consumer of premiumSurface.light in theme.ts button blocks for consistency
   (contained, outlined, text buttons with shadows, list items, toggle buttons, cards if
   they share the token) — buttons only; cards/other surfaces are A16's scope, but if a
   card uses the same token your change affects it, verify it still looks correct and
   note it in your report.
5. Verify: light mode buttons at rest/hover/active/selected + disabled; dark mode visually
   IDENTICAL to before (screenshot diff).

REQUIREMENTS
- Dark mode pixel-unchanged. Light mode: subtle top-light emboss, no muddy/dark inset.
- Contrast (label vs background) must not regress.

TESTS
- If shadows.ts grows helper functions, unit-test them; otherwise document the visual
  matrix (states x modes) with screenshots in the report.

I18N
- None.

DEFINITION OF DONE
- Light-mode buttons match the intended emboss language across rest/hover/active/
  selected/disabled; dark mode unchanged (verified by screenshot).
- check-types, lint, test green.

BOUNDARIES
- Do not redesign drop shadows or non-button surfaces — that is A16 (after you on both
  theme.ts and shadows.ts). Leave shadows.ts token names/structure stable for A16.
```

---

## Agent A15 — Style Hotkey + Import audio must not show Styles when disabled

**Issue (verbatim):** "The Style Hotkey and import audio, shows Styles even when they haven't been enabled"

**Grounded context (verified):**
- AI post-processing enablement lives in `settings.state.ts` as `aiPostProcessing: SettingsGenerativeState { mode, selectedApiKeyId }` — `mode: null` means post-processing/styling is effectively off. The exact "enabled" derivation (mode + provider key present) is in the settings UI (`AIPostProcessingConfiguration.tsx` / `SettingsPage.tsx`).
- `StyleHotkeysDialog.tsx` (opened from `SettingsPage.tsx` ~line 360 "Style hotkeys" entry) lists styles and their hotkeys regardless of whether styling is enabled.
- `TranscriptionsPage.tsx` "Import audio" dialog (~line 92+) has a Style `<Select>` pre-populated with the first tone even when styling is disabled; same pattern in `RetranscribeDialog.tsx` (Style select).
- A gating precedent exists: `src/components/styling/PostProcessingDisabledTooltip.tsx` — reuse its pattern for disabled-with-tooltip affordances.

**Owns:** `StyleHotkeysDialog.tsx`, `TranscriptionsPage.tsx` (import dialog only), `RetranscribeDialog.tsx` (Style select gating only — you are SECOND on this file, after A10), `PostProcessingDisabledTooltip.tsx` if you need to generalize it.

```markdown
[Agent A15 — Gate style selectors behind post-processing enablement]

MISSION
Everywhere the UI offers a style/tone choice (Style Hotkeys dialog, Import audio dialog,
Retranscribe dialog, and any other surface you find), it must reflect whether styling is
actually enabled: hidden (with the section's affordance still present) or visibly
disabled-with-reason when post-processing is off — never a silently-functional selector
that suggests styles will be applied when they won't.

GROUND TRUTH
- settings.state.ts: aiPostProcessing { mode, selectedApiKeyId }; derive "enabled" exactly
  as the settings UI does (check AIPostProcessingConfiguration.tsx / SettingsPage.tsx for
  the canonical predicate — do not invent a second one; extract and reuse it if needed).
- StyleHotkeysDialog.tsx opens from SettingsPage.tsx ~line 360.
- TranscriptionsPage.tsx import dialog Style select ~line 92+; RetranscribeDialog.tsx
  Style select.
- PostProcessingDisabledTooltip.tsx exists as the disabled-with-reason precedent.

WALK (end to end)
1. Identify the canonical "is styling enabled" predicate (single source of truth; if none
   exists, create one in a shared util and note it in your report).
2. Define per-surface behavior:
   - Style Hotkeys dialog: when styling is disabled, either hide the entry point in
     Settings or render the dialog's rows with the disabled tooltip explaining why
     (choose per Settings UX: recommend keeping the entry but disabling rows + tooltip,
     consistent with PostProcessingDisabledTooltip).
   - Import audio dialog: hide the Style select when disabled (import transcribes with
     no styling); if the pipeline can still use a style later (verify with
     transcribe-audio repo), then keep the select but disabled with tooltip — the
     VERIFIED pipeline behavior decides which.
   - Retranscribe dialog: same rule.
3. Sweep for every other style selector (grep `getSortedToneIds` / tone selects across
   src) and apply the same gate; list any out-of-lane ones as findings.
4. Edge cases: user disables post-processing WHILE a dialog is open (live-update the
   gate); user has zero styles defined (selector already handles empty — verify no
   empty-dropdown regressions); enterprise/local modes where styles come from built-ins.
5. Verify the pill's style selector is unaffected (it is driven by the same underlying
   style state — check notify_pill_style_info; if the pill shows styles while disabled,
   file a finding for A22, do not fix the Rust).

REQUIREMENTS
- One shared predicate; no duplicated "enabled" logic.
- Disabled states must explain WHY (tooltip/message), not just grey out.

TESTS
- Unit-test the extracted predicate for the mode/key combinations.
- Component tests for the two dialogs (styles hidden/disabled when off; enabled when on)
  following repo test conventions.

I18N
- Any new tooltip/copy via FormattedMessage defaultMessage; run pnpm --filter desktop i18n.

DEFINITION OF DONE
- With styling disabled: Style Hotkeys, Import audio, and Retranscribe dialogs no longer
  present functional style choices; with it enabled: behavior identical to today.
- check-types, lint, test green.

BOUNDARIES
- RetranscribeDialog.tsx: A10 was first — do not undo their loading/toast work.
- Do not change the pill (A22) or tone.actions (A09).
```

---

## Agent A16 — Mirror the inner/drop shadow design into light mode

**Issue (verbatim):** "Mirror / port the inner/drop shadow design, into light mode"

**Grounded context (verified):**
- `src/styles/shadows.ts` `premiumSurface.light` vs `premiumSurface.dark` differ structurally: dark uses deeper multi-stop drop shadows + subtle inset highlights tuned for dark surfaces; light uses warm-tinted drops but the design language (per the issue and DESIGN.md "Sigma-style layered surfaces") should be mirrored so light mode gets the same layered inner-highlight + soft drop-shadow treatment as dark, adapted for light backgrounds.
- Consumers: `theme.ts` (buttons, list items, cards, title bar uses `titleBarShadow`, hairlines), `TitleBar.tsx` (titleBarShadow), pages using premiumSurface via sx.
- A14 (before you) already corrected the light BUTTON inner-shadow alphas. You own the full light-mode shadow LANGUAGE: evolve tokens + apply consistently.

**Owns:** `shadows.ts` (second owner — extend, keep A14's corrections intact), `theme.ts` (second owner — shadow-consuming blocks only, after A07/A14), `TitleBar.tsx` shadow usage, any sx-level shadow usages that must consume the new tokens.

```markdown
[Agent A16 — Mirror the inner/drop shadow design into light mode]

MISSION
Port the layered inner-highlight + soft drop-shadow design (as refined in dark mode) into
light mode, applied consistently across buttons, cards, list items, inputs and the title
bar, so both modes share one visual language with mode-appropriate values.

GROUND TRUTH
- shadows.ts: premiumSurface.light/dark, titleBarShadow, hairline. DESIGN.md describes
  the intended layered-surface language.
- A14 already tuned light-mode BUTTON insets — do not regress their fix.
- Consumers: theme.ts override blocks (buttons ~300-495, cards, list items), TitleBar.tsx
  (titleBarShadow.light/dark).

WALK (end to end)
1. Audit current light-mode surfaces against dark-mode ones (screenshot every surface
   class in both modes): buttons, cards, list items, toggles, dialogs, title bar,
   tooltips/menus. Catalogue where dark has layered depth and light does not.
2. Design the light-mode token values: same structure as dark (inset top highlight +
   multi-stop soft drops) but warm-tinted via the existing ink/highlight helpers (light
   shadows should sit ON cream, not grey it out — per shadows.ts comments). Decide per
   elevation level (rest/hover/active/selected).
3. Update premiumSurface.light.* (extend, keeping A14's inset alphas or superseding them
   ONLY with their documented intent preserved — verify their button fix still reads
   correct), titleBarShadow.light, and any hairline tuning needed for the new language.
4. Apply consistently: theme.ts consumers should reference the tokens (no ad-hoc shadow
   strings); TitleBar.tsx uses titleBarShadow — verify with new light values.
5. Verify contrast and clarity in light mode across: home cards, settings sections,
   dialogs, menus, title bar; and confirm dark mode is pixel-unchanged.
6. Check performance: shadow changes must not add expensive blur/backdrop costs
   (A12's idle budget) — prefer pre-composed box-shadow strings (current approach).

REQUIREMENTS
- One language, two modes; no new hardcoded shadow strings outside shadows.ts.
- A14's button corrections must remain visibly correct (re-verify their DoD).
- No changes to layout or colors outside shadow tokens.

TESTS
- If you add pure token helpers, unit-test them; otherwise the visual matrix (modes x
  surfaces x states) with screenshots is the evidence — include it in the report.

I18N
- None.

DEFINITION OF DONE
- Light mode surfaces carry the mirrored layered shadow language; dark mode unchanged
  (screenshot-diffed); A14's button fix intact.
- check-types, lint, test green.

BOUNDARIES
- You are third on theme.ts (after A07 slider, A14 buttons) and second on shadows.ts —
  preserve their outcomes. Do not redesign the pill (Rust) or other agents' components.
```

---

## Agent A17 — Satoshi for "Click to dictate" + active style text, animate to "Drag To Move"

**Issue (verbatim):** "Make the text 'Click to dictate' use the Satoshi Font, without having to be installed in system, also make the Active style text use the font too. then make it animate to 'Drag To Move'"

**Grounded context (verified):**
- All three pill crates bundle `fonts/Satoshi-Medium.ttf` and register it at runtime: `rust_macos_pill/src/font.rs` (`install_embedded_satoshi` via CTFontManagerRegisterFontsForURL, process-scope), `rust_windows_pill/src/font.rs` + `gfx.rs` (`crate::font::install_embedded_satoshi`, `create_text_format`), `rust_gtk_pill` likewise. The idle label already selects "Satoshi" in `draw_idle_label` (macOS `draw.rs:315`; GTK `draw.rs:543`; Windows `draw.rs:278` via `gfx.draw_text_centered`).
- The bug report says it does NOT use Satoshi without a system install — the most likely reality: on one or more platforms the registration/face-name lookup fails when Satoshi is not installed system-wide (macOS face-name lookup order, Windows DirectWrite font collection vs AddFontResourceEx lifetime, GTK fontconfig app-fonts), silently falling back to a system font. VERIFY per platform.
- The active-style text = the pill's style name tooltip/label (`draw_tooltip` in each draw.rs uses "Satoshi").
- There is no "Drag To Move" state today: the idle label is static. The animation target: while the pill is being dragged (or held for drag), the label morphs from "Click to dictate" to "Drag To Move" (and back) — confirm the intended trigger from the pill's drag state machine (`rust_pill_shared` DRAG_INFLATE_* + each pill's input/state).

**Owns:** all three pill crates' `font.rs` + `draw.rs` idle-label/tooltip sections (FIRST on draw.rs; A13/A04 follow), `rust_pill_shared` for any shared label-animation math.

```markdown
[Agent A17 — Embedded Satoshi everywhere + "Drag To Move" label animation]

MISSION
(1) "Click to dictate" and the active-style text must render in Satoshi on all three
platforms using ONLY the embedded font — zero dependency on a system install.
(2) The idle label must animate to "Drag To Move" (and back) with a premium crossfade/
slide while dragging, using the same embedded face.

GROUND TRUTH
- fonts/Satoshi-Medium.ttf ships in all three pill crates; font.rs registers it per
  platform (macOS CTFontManager process-scope; Windows DirectWrite via install_embedded_
  satoshi + create_text_format; GTK fontconfig).
- draw_idle_label hardcodes "Click to dictate" (macOS draw.rs:315, GTK draw.rs:543,
  Windows draw.rs:278); draw_tooltip draws the style name in "Satoshi".
- rust_pill_shared has DRAG_INFLATE_* constants and the ring math; each pill has a drag
  state machine (input.rs/state.rs/app.rs).

WALK (end to end)
1. Verify the actual failure per platform: run each pill WITHOUT Satoshi installed
   system-wide; screenshot the idle label and the style tooltip; check whether the text
   uses Satoshi or a fallback (compare glyph shapes/metrics vs the bundled ttf). Identify
   which platform(s) fall back and why (registration scope, face-name mismatch, font
   collection not refreshed, GTK not adding app font, etc.).
2. Fix registration so the embedded face is authoritative on every platform:
   - macOS: keep CTFontManagerRegisterFontsForURL but verify the face name lookup in
     draw (PostScript name "Satoshi-Medium") matches registration; register BEFORE any
     draw; avoid temp-dir races (multiple pill instances writing the same file).
   - Windows: ensure AddFontResourceEx / DirectWrite custom font collection keeps the
     font valid for the render target lifetime (private collection per factory if
     needed) — the renderer must never fall back silently; fail loudly in debug if the
     face is missing.
   - GTK: register via fontconfig app fonts (FcConfigAppFontAddFile) or load the ttf
     directly for Pango (pango has APIs for font bytes) so no system install is needed.
   - Keep "no system install" as the invariant; add a debug assertion/log when the
     embedded face cannot be selected.
3. Confirm the active-style text (tooltip + any expanded-state style label) uses the
   same face and correct weight (Medium only — no fake-bold synthesis).
4. Implement the label animation: a shared, simple two-state transition ("Click to
   dictate" <-> "Drag To Move") keyed to the drag state (entering/exiting drag), with
   crossfade + slight vertical slide, spring/timing consistent with the existing
   DRAG_INFLATE spring constants (stiffness 280). Animate on a per-frame driver already
   present in each pill (reuse the existing animation loop — do NOT add a second loop).
   Determine the exact trigger from the drag state machine (drag-hold armed vs actually
   moving) and document it.
5. Ensure the animated label does not fight A13's long-press ring visuals or tooltips;
   keep text metrics stable (no layout jitter during the swap — crossfade two pre-measured
   labels).
6. Verify on all three platforms: light and dark wallpaper, idle, hover, long-press,
   drag, release, tooltip.

REQUIREMENTS
- Satoshi everywhere, from embedded bytes only; NO system font fallback for these labels.
- Animation respects prefers-reduced-motion (if the pill receives that pref — if not,
  keep the animation subtle enough to be safe).
- No new dependencies.

TESTS
- Rust unit tests where possible (font registration idempotence, face lookup).
- Manual visual matrix documented (3 platforms x 6 states) with screenshots.

I18N
- Label strings "Click to dictate" / "Drag To Move" are pill-visible: check how pill
  strings are localized today (they are hardcoded in draw.rs — if a localization channel
  exists for pill labels, route through it; otherwise note this as an out-of-lane finding
  for the i18n owner and keep strings as-is).

DEFINITION OF DONE
- On a clean system (no Satoshi installed): idle label and style tooltip render in
  Satoshi on macOS + Windows (+ Linux if runnable); label animates to "Drag To Move"
  during drag and back on release.
- cargo fmt/clippy/test green for touched crates.

BOUNDARIES
- FIRST on draw.rs: leave the long-press ring (A13) and assistant panel (A04) sections
  untouched. Do not change drag geometry/timing constants.
```

---

## Agent A18 — Tray item "Open Dashboard" ↔ "Hide Dashboard"

**Issue (verbatim):** "Make the tray element 'Open Dashboard' turn to 'Hide Dashboard' when the dashboard is open"

**Grounded context (verified):**
- `src-tauri/src/system/tray.rs` (~line 80): `MenuItem::with_id(app, "open-dashboard", "Open Dashboard", ...)`; on menu event it calls `crate::platform::window::surface_main_window(&window)`.
- Precedent for frontend-synced tray labels exists IN THE SAME FILE: `set_pill_visibility_menu_state` (the frontend resolves the localized label and pushes it via a command), and `set_register_app_label`.
- The main window hides-to-tray on CloseRequested (`app.rs` ~150) and can be re-surfaced via `surface_main_window`; visibility state can be tracked via window events (`WindowEvent::Focused`/`CloseRequested`/`Hide`) or explicit TS calls (`window.utils.ts` has window helpers; `AppSideEffects.tsx` listens to window events).
- Tray label sync utilities: `src/utils/tray-language.utils.ts`, `src/utils/tray-pill-visibility.utils.ts` (+ tests) — follow these patterns.

**Owns:** `system/tray.rs` (dashboard item label + click behavior), a new/existing command for the label+visibility sync (FIRST on `commands.rs`; A08/A03 follow), `window.utils.ts`/`tray-pill-visibility.utils.ts` patterns in a new util (e.g. `tray-dashboard-visibility.utils.ts` + test), the TS sync caller in `AppSideEffects.tsx` (dashboard-visibility section only — A03/A21 come later).

```markdown
[Agent A18 — Tray dashboard item mirrors open/closed state]

MISSION
The tray item reads "Open Dashboard" when the dashboard window is hidden/closed-to-tray
and "Hide Dashboard" when it is visible; clicking it hides/shows accordingly, and the
label always matches reality (including after close-to-tray, minimize, and re-surface
from other paths).

GROUND TRUTH
- tray.rs ~80: static "Open Dashboard" item, click = surface_main_window only.
- set_pill_visibility_menu_state (tray.rs) is the label-sync precedent (frontend
  resolves label, pushes via command). Tauri WindowEvent::CloseRequested hides the
  window (app.rs ~150).
- TS side: window.utils.ts helpers, AppSideEffects window listeners, tray-pill-visibility
  utils + tests as pattern.

WALK (end to end)
1. Enumerate every path that changes dashboard visibility: tray open click,
   close-to-tray (X button), minimize, focus from OS, autostart-hidden, elevation flow
   (A03's future quit path must not break your state — keep your state derivation
   window-event-based so it stays correct).
2. Rust: make the tray click a toggle — if the main window is visible (and on top), hide
   it; else surface it (existing surface_main_window). Track visibility from window
   events rather than guessing (add hide/show handling where surface_main_window/hide
   are called centrally, e.g. platform/window.rs).
3. Rust: label sync — mirror the pill-visibility pattern: a command (e.g.
   set_dashboard_menu_state / set_tray_dashboard_label) that sets the item text; call it
   from the Rust side on state change OR from TS with the localized label (prefer the
   pattern that keeps localization in TS, consistent with tray-pill-visibility utils).
   Keep the static "open-dashboard" id or introduce "toggle-dashboard" — document the
   choice; keep tray-language tests passing.
4. TS: resolve the localized label ("Open Dashboard" / "Hide Dashboard") via the i18n
   catalogs and push on visibility change (useTauriListen on window events in
   AppSideEffects, or the existing sync util pattern). Ensure main-window-only guard
   (composer popout must not fight for the label).
5. Edge cases: window focused but minimized; visible but not focused; multiple rapid
   clicks (debounce label pushes); app exit path (tray teardown).
6. Update tray-pill-visibility-utils-style tests for the new util and any tray.rs
   changes; keep existing tray tests green.

REQUIREMENTS
- Localized labels (no hardcoded English in Rust beyond the pre-hydration default,
  matching the pill-visibility pattern).
- Toggle must never leave the window in a state contradicting the label.

TESTS
- Unit tests for the new tray-dashboard-visibility util (label selection per state).
- Rust: extend any tray tests for the toggle behavior if a harness exists.

I18N
- New strings via the existing tray-language sync channel; run pnpm --filter desktop i18n.

DEFINITION OF DONE
- Verified on the platform(s) available: open tray -> "Hide Dashboard" when visible,
  click hides window; "Open Dashboard" when hidden, click re-surfaces; X-to-tray flips
  the label; label localized.
- check-types, lint, test, cargo fmt/clippy/test green.

BOUNDARIES
- FIRST on commands.rs: add only your command(s); A08/A03 come after and must not
  collide (distinct names). Do not touch pill tray items (set_pill_visibility_menu_state).
```

---

## Agent A19 — Remove em-dashes everywhere + humanize skill against AI slop

**Issue (verbatim):** "Remove all the em-dashes, and load a humanize skill to get rid of AI slop on the entire app"

**Grounded context (verified):**
- 82 em-dash occurrences in `apps/desktop/src` at triage: most are code comments, but some are USER-FACING copy (e.g. `ElevationDeclinedDialog.tsx:45` body text contains "—"), plus the i18n locale catalogs (`src/i18n/locales/*.json`).
- Prompt/skill precedent: `scripts/prompts/polished.txt` already instructs "Do NOT use em-dash symbols (—) in your response" for transcript polish; `packages/agent/src/` (agent-loop.ts, types.ts) and `apps/desktop/src/agents/agent-configs.ts` + `run-agent.ts` build the agent/post-processing prompts; built-in styles live under `apps/desktop/src/components/styling` / tone definitions.
- A "humanize skill" means: a reusable instruction/prompt artifact + pipeline hook that de-sloppifies LLM output (banned AI-isms: em-dashes, "delve", "seamless", "unlock", "game-changer", over-corporate phrasing, etc.) applied to agent responses AND AI post-processing output app-wide.

**Owns:** user-facing copy sweep (components + i18n locales — code comments are out of scope unless they mislead), `packages/agent` prompt/skill assembly, `scripts/prompts/` (new humanize skill), the agent/post-processing prompt construction in `apps/desktop/src/agents/` and `src/utils/ai.utils.ts` if needed.

```markdown
[Agent A19 — Em-dash purge + humanize skill]

MISSION
(1) Zero em-dashes in user-facing product copy (UI strings and locale catalogs).
(2) A first-class "humanize" skill loaded into the agent/post-processing pipeline that
removes AI-slop markers from ALL LLM output the app produces, without changing meaning.

GROUND TRUTH
- Em-dashes exist in user-facing copy (e.g. ElevationDeclinedDialog.tsx:45) and locale
  catalogs; most of the 82 hits are code comments (do NOT touch comments — that churn
  belongs to their owners).
- scripts/prompts/polished.txt is the existing "no em-dash" prompt precedent.
- packages/agent/src/agent-loop.ts assembles agent system/user prompts;
  apps/desktop/src/agents/agent-configs.ts + run-agent.ts configure the app's agents;
  AI post-processing prompts live around AIPostProcessingConfiguration / voice-ai /
  tone definitions.

WALK (end to end)
1. Sweep user-facing strings: grep em-dash across src/components, src/actions, src/utils
   (NOT test fixtures' expectations unless they assert user copy), and ALL
   src/i18n/locales/*.json. Replace with commas, periods, colons, or parentheses —
   preserving meaning and tone. Run pnpm --filter desktop i18n to re-sync catalogs.
   Coordinate with other agents' new strings: they run before/alongside you; the sweep
   must also catch their additions at the end (you are the final copy gate — include a
   final sweep step in your DoD).
2. Design the humanize skill as a standalone prompt artifact (like polished.txt) under
   scripts/prompts/ (e.g. humanize.txt): a compact rule set (banned markers with
   replacements, plain-spoken tone, concrete examples) reusable across pipelines. Keep
   it deterministic and model-agnostic.
3. Load it where LLM text is produced: the agent loop (packages/agent) and AI
   post-processing (wherever tone/style prompts are assembled). Make it an explicit,
   testable component of the prompt assembly (a function returning the skill text, not
   inline duplicated paragraphs — DRY).
4. Apply a post-hoc scrubber as a safety net: a pure TS function that removes/repairs
   residual slop markers (em-dash replacement, banned phrases -> neutral alternatives,
   spacing normalization) applied to final agent/post-processing output before display/
   insertion. Unit-test it against a fixture of slop-heavy outputs. Decide carefully
   which markers are replaced mechanically vs left to the prompt (do not butcher
   legitimate text — the scrubber must be conservative).
5. Verify: agent mode responses and styled dictation output come out slop-free in
   practice (manual runs + the unit fixtures); no regression in the email/polish
   pipeline (polished.txt consumers unchanged unless you extend them deliberately).
6. Audit built-in styles/tone definitions for AI-slop phrasing and fix the worst cases
   (user-facing examples), listing the rest as findings.

REQUIREMENTS
- No meaning changes in copy; no em-dash replacements that break hyphenation rules.
- The humanize skill is ONE shared artifact; every pipeline loads it from the same place.
- Locales stay synchronized (run i18n extract + sync).

TESTS
- Unit tests for the scrubber (fixtures: em-dashes, banned phrases, false positives it
  must NOT alter).
- If the prompt assembly is refactored, test that the humanize skill is included in the
  assembled agent/post-processing prompts.

I18N
- Core deliverable: strings change across locales; run pnpm --filter desktop i18n and
  review each catalog diff.

DEFINITION OF DONE
- grep shows zero em-dashes in user-facing copy + locales; humanize skill loaded in
  agent + post-processing; scrubber green; manual slop sample rendered human.
- check-types, lint, test green.

BOUNDARIES
- Do NOT mass-edit code comments (out of scope; would collide with every other agent).
  Final copy sweep must run after the other waves land — coordinate your last pass at
  the end of wave 4.
```

---

## Agent A20 — Documentation for "Register App"

**Issue (verbatim):** "Add documentation for what Register App does."

**Grounded context (verified):**
- Two surfaces: the tray menu item "Register current app" (`src-tauri/src/system/tray.rs`, id `register-current-app`, emits `EVT_REGISTER_CURRENT_APP`) and the dashboard UI ("Register App" / register flow — trace `src/components/dashboard/DashboardPage.tsx` and `src/actions/app-target.actions.ts` for the full behavior).
- The authoritative docs site is `apps/docs` (Astro + Starlight), content under `apps/docs/src/content/docs/`; repo-root `docs/` is loose notes (per AGENTS.md, prefer the docs site).
- What it does (verify by reading the implementation, do not guess): captures the currently-focused app as an app target (name/title detection), registers it for app-specific preferences (insertion method, paste keybind, per-app tone, typing speed — see `appTargetById` in app.state and AppTarget type in `@maus-inc/types`), and shows it in the app list.

**Owns:** `apps/docs` content (new page + nav/links) and, if warranted, a short in-app helper/tooltip string near the Register App button (SettingsPage/DashboardPage minimal copy addition — coordinate: only if the button currently lacks any explanation).

```markdown
[Agent A20 — Document "Register App"]

MISSION
Publish clear, accurate user documentation for "Register App": what it does, when to use
it, step-by-step usage, what changes after registration, and troubleshooting.

GROUND TRUTH
- Tray item "Register current app" (tray.rs, EVT_REGISTER_CURRENT_APP) + dashboard
  "Register App" surface; implementation lives in app-target.actions.ts /
  DashboardPage.tsx / types (AppTarget).
- Docs site: apps/docs (Astro Starlight), content in apps/docs/src/content/docs/.
- AGENTS.md: prefer docs site over root docs/.

WALK (end to end)
1. Read the implementation end to end (tray event -> action -> repo -> persistence) and
   produce a verified behavior description: how the current app is detected, what
   attributes are stored (per-app tone, insertion method, paste keybind, typing speed),
   where the registered app appears, and any platform caveats (admin apps, detection
   failures).
2. Write the doc page (matching Starlight conventions: frontmatter, title, sections):
   Overview / How to register (tray + dashboard paths) / What it changes / Per-app
   settings explained / Troubleshooting (app not detected, wrong app registered,
   removed apps) / Privacy note (what is stored, where).
3. Add it to the sidebar/nav config and cross-link from related pages (settings,
   dictation behavior docs) — check existing nav structure first.
4. If the in-app button has NO explanation today, add a one-line helper/tooltip via
   FormattedMessage defaultMessage (keep it to one string; run i18n). If it already
   explains itself, skip.
5. Build the docs site (pnpm --filter docs build / check-types per AGENTS.md) and
   visually verify the page renders (pnpm --filter docs dev).

REQUIREMENTS
- Docs describe REAL behavior (verified against code), not assumptions.
- Keep docs in English to match existing content conventions; follow Starlight style.

TESTS
- Docs build + type-check green; links validated (no broken internal links).

I18N
- Only if you add the in-app helper string: run pnpm --filter desktop i18n.

DEFINITION OF DONE
- New docs page live in apps/docs, linked in nav; in-app helper (if added) shipped;
  build green.

BOUNDARIES
- Do not change Register App behavior — documentation only. Do not touch tray.rs (A18).
```

---

## Agent A21 — Filter hotkey spam while the pill is already active

**Issue (verbatim):** "If the pill is already in an active state, any hotkey spam noise should be filtered out."

**Grounded context (verified):**
- Hotkey events flow: native listener → `bridge_hotkey_trigger` Tauri event → `AppSideEffects.tsx` (~line 318) increments `draft.hotkeyTriggers[payload.hotkey]` (a counter) → `DictationSideEffects.tsx` (and possibly KeyPressSideEffects.tsx) react to counter changes and act (start/stop dictation, style switch, etc.).
- While the pill is already recording (`overlayPhase === "recording"` in `app.state.ts`), repeated trigger events (key auto-repeat, spamming the hotkey, duplicate events from multiple listeners) can re-fire the same action — the "spam noise".
- `keysHeld` state exists (updated from `keys_held` events) and is already used for hold semantics and Left/Right style switching.

**Owns:** the hotkey trigger handling in `AppSideEffects.tsx` (you are SECOND on this file, after A03) and the consumer-side filtering in `DictationSideEffects.tsx` (you are LAST on it, after A08/A09/A22 — additive filtering only).

```markdown
[Agent A21 — Hotkey spam filtering while pill is active]

MISSION
While the pill is in an active dictation state, repeated/noisy hotkey triggers for the
SAME action must be filtered (coalesced/ignored) so they cannot restart dictation, spam
style switches, or cause flicker — while legitimate distinct hotkeys (e.g. stop, cancel,
style cycle) keep working instantly.

GROUND TRUTH
- AppSideEffects.tsx ~318: hotkeyTriggers[hotkey]++ on bridge_hotkey_trigger.
- DictationSideEffects.tsx consumes hotkeyTriggers (start/stop/cycle paths) and holds
  keysHeld + overlayPhase (app.state.ts) for active-session logic.
- Hotkey grab fingerprint + sync already exist in AppSideEffects (hotkeyGrabFingerprint).

WALK (end to end)
1. Reproduce: start dictation, hold or mash the activation hotkey (or trigger it via the
   bridge repeatedly at high frequency); record how many times the consumer reacts
   (instrument counters). Identify whether repeats come from key auto-repeat, duplicate
   events, or re-sync churn.
2. Design the filter at the right layer (prefer ONE layer to keep semantics simple):
   - Option A (source): in AppSideEffects, collapse repeated identical hotkey events
     while the same physical key is held (keysHeld already tells you) and while
     overlayPhase is recording — a trigger for an action that is already active is
     dropped (except explicit toggle/stop actions).
   - Option B (consumer): in DictationSideEffects, guard each hotkey-driven action with
     an idempotency check (action already in target state -> ignore; per-action debounce
     window; release-before-refire requirement for restart).
   - Combine only if needed; document the chosen model. Ensure "stop" and "cancel"
     actions are NEVER filtered into a stuck state (an active pill must always be
     stoppable).
3. Preserve: Left/Right style switching while holding the dictate key (A09's behavior),
   distinct hotkeys firing close together, and the first trigger after release working
   immediately (no lingering debounce).
4. Verify against the pill's own state (overlayPhase) — the filter must key off the
   authoritative active state, not a guess.
5. Check interaction with A08's backlog (hotkey-driven stop must still drain the
   backlog exactly once) and A22's style-switch IPC.

REQUIREMENTS
- No action can get stuck (safety: always allow stop/cancel).
- No added latency for legitimate first presses.
- Filtering logic pure and unit-testable (extract a decision function).

TESTS
- Unit tests for the filter decision function: repeat-while-held during recording,
  distinct hotkey during recording, stop during recording, first trigger after release,
  restart-after-stop, rapid distinct cycles.
- Update any existing hotkey-trigger tests (AppSideEffects/DictationSideEffects test
  conventions).

I18N
- None.

DEFINITION OF DONE
- Hammering the activation hotkey during recording produces zero redundant reactions;
  stop/cancel/style-cycle remain instant; normal single-press latency unchanged.
- check-types, lint, test green.

BOUNDARIES
- Last on both files: only additive filtering. Do not rework A03's elevation effect,
  A08's backlog, A09's style semantics, or A22's IPC wiring.
```

---

## Agent A22 — Top style selector on the pill: switching doesn't apply

**Issue (verbatim):** "Clicking on the top style selector, on the pill and switching doesn't apply"

**Grounded context (verified):**
- The pill's top tooltip is the style selector: chevrons + style name (`draw_tooltip` in each pill's draw.rs; click regions hit-test chevrons → `input.rs` `ClickAction::StyleForward/StyleBackward` → `ipc.rs` `OutMessage::StyleSwitch { direction }`).
- Desktop side: `src-tauri/src/pill_process.rs` (~line 350) parses `"style_switch"` lines from the pill process and (for the overlay path) `platform/{macos,windows,linux}/overlay.rs` `start_out_reader` handles OutMessage variants → emits a Tauri event to TS.
- TS side: the event lands in `DictationSideEffects.tsx` (style/phase pipeline; `notify_pill_style_info` at ~1312 pushes the current style back to the pill). The style mutation functions are `tone.actions.ts` (`cycleWritingStyle`, `selectToneByHotkey`).
- The bug: clicking the chevrons visibly cycles the pill's tooltip name (or not?) but the ACTIVE writing style (the one dictation applies) does not change — the StyleSwitch event is either not wired to `cycleWritingStyle`, wired to a different state slot, dropped when not dictating, or lost in the main-window-only guard.

**Owns:** the StyleSwitch consumer path in TS (`DictationSideEffects.tsx` — you are THIRD on it, after A08/A09), `tone.actions.ts` (SECOND, after A09), `pill_process.rs` + `overlay.rs` message handling only if the event never reaches TS, and the pill `input.rs`/`ipc.rs` only if the message itself is malformed (you are FIRST on input.rs; A23 follows).

```markdown
[Agent A22 — Pill top style selector must actually apply the style]

MISSION
Clicking the pill's top style selector chevrons must switch the ACTIVE writing style the
same way the in-app selectors do (state + pill tooltip + subsequent dictation), in idle
AND active states, on all platforms.

GROUND TRUTH
- Pill: input.rs ClickAction::StyleForward/Backward -> OutMessage::StyleSwitch{direction};
  draw_tooltip shows style_name/style_count from InMessage::StyleInfo.
- Rust bridge: pill_process.rs ~350 parses "style_switch"; platform overlay.rs
  start_out_reader dispatches OutMessage variants -> Tauri events to TS.
- TS: DictationSideEffects.tsx owns the style pipeline + notify_pill_style_info (~1312);
  tone.actions.ts has cycleWritingStyle/selectToneByHotkey.
- A09 (before you) fixed mid-dictation switch semantics; A08 added the backlog. Your fix
  must compose with both.

WALK (end to end)
1. Trace the full path with logging (Rust overlay reader + TS listener): click a chevron
   and verify at each hop whether StyleSwitch arrives (Rust), which event TS receives,
   and which action fires (or doesn't). Identify the broken hop — candidates: event
   emitted only to the wrong window, TS listener missing/not in main-window guard,
   handler writes a display-only state, or tone.actions path bypassed.
2. Fix the broken hop to call the SAME transition the in-app style selectors use
   (cycleWritingStyle for direction, sharing A09's semantics) so pill switching and
   in-app switching can never diverge.
3. Ensure the pill tooltip refreshes after switching (StyleInfo / notify_pill_style_info
   round-trip) and that the switch works while: idle, recording, paused, and assistant
   mode active (if style switching is meaningful there — otherwise explicitly disabled
   with reason, not silently broken).
4. Verify the Left/Right hotkey channel and in-app selectors still work after your
   change (A09's DoD must stay green) — all channels should converge on the same state
   transition.
5. If the pill itself sends a malformed message (e.g. direction casing), fix input.rs/
   ipc.rs minimally and add a Rust-side assertion/test.
6. Edge cases: style_count <= 1 (tooltip hidden today — keep), rapid chevron clicks
   (coalesce/queue safely), mid-utterance switch (A09 semantics), first click after
   pill spawn (StateInfo hydration race).

REQUIREMENTS
- One shared state transition for ALL switch channels.
- The pill tooltip never shows a style name that isn't the applied active style.

TESTS
- TS: test the StyleSwitch event handler with mocked invoke (assert it calls the shared
  transition); extend tone.actions tests if A09 left helpers.
- Rust: if you touch message parsing, add a unit test for the style_switch line format.

I18N
- None (tooltip shows style names).

DEFINITION OF DONE
- Manual matrix: chevron switching applies the style in idle + recording states on the
  platform(s) available; tooltip + dictation output agree; A09's hotkey/arrow paths
  still green.
- check-types, lint, test, cargo fmt/clippy/test green.

BOUNDARIES
- Third on DictationSideEffects.tsx (after A08/A09): preserve their fixes. First on
  input.rs: leave it clean for A23's haptics. Do not redesign tooltip visuals (A17/A13).
```

---

## Agent A23 — Thock Haptics Overhaul for Pill Interactions

**Issue (verbatim):** "Thock Haptics Overhaul for Pill Interactions"

**Grounded context (verified):**
- No haptics exist in the pill crates today (verified: no NSHaptic/Haptic references). Interactions live in `packages/rust_macos_pill/src/input.rs` (ClickAction mapping: click, long-press, style chevrons, cancel) with mirrors in windows/gtk pills.
- Audio feedback precedent: `src-tauri/src/system/audio_feedback.rs` — a warm rodio OutputStream thread playing `assets/audio/*.wav` (start-recording, stop-recording, alert-*) with an mpsc `AudioRequest::Play` channel; gated in Settings by "Interaction chime" (`playInteractionChime` in AudioDialog.tsx).
- macOS supports real haptics (NSHapticFeedbackManager); Windows/Linux do not have a universal haptic API — a "thock" (low, tactile click sound) via the existing audio channel is the cross-platform equivalent. Pill crates are separate processes: they can request chimes either via their existing IPC to the desktop (ipc.rs OutMessage) or natively.

**Owns:** pill `input.rs` (you are SECOND, after A22), pill `ipc.rs` (additive OutMessage variant if needed), `src-tauri/src/system/audio_feedback.rs` + `assets/audio/` (new thock clips), the desktop handler for the new message (in `overlay.rs`/`pill_process.rs` — additive only), `AudioDialog.tsx` copy ONLY if the chime pref description must change (coordinate with A10's dialog ownership — AudioDialog is not theirs, but keep copy changes minimal).

```markdown
[Agent A23 — Thock haptics overhaul for pill interactions]

MISSION
Give every meaningful pill interaction a consistent, premium "thock" feedback signature:
real haptics where the platform supports them (macOS), synthesized thock audio everywhere
(macOS/Windows/Linux), honoring the user's "Interaction chime" preference, with distinct
but harmonious profiles per gesture (press, long-press progress, activation, cancel,
style chevron, drag pickup/drop).

GROUND TRUTH
- input.rs maps gestures to ClickAction (per platform); ipc.rs defines OutMessage variants.
- audio_feedback.rs: rodio thread, AudioRequest::Play(&'static [u8]), warm stream;
  assets/audio/*.wav exist (start-recording, stop-recording, alert-*).
- Settings gate: playInteractionChime (AudioDialog.tsx). Pill processes are separate
  binaries — audio plays from the DESKTOP process (the pill should request via IPC, not
  open its own audio device, to respect the preference and avoid device contention).

WALK (end to end)
1. Design the feedback map (document it in your report): gesture -> haptic level
   (macOS) + thock profile. Keep total latency < ~50ms (pre-warmed channel exists).
2. macOS haptics: add NSHapticFeedbackManager calls (alignment/levelChange/generic per
   gesture) in the macOS pill input handler, gated by the same user preference (the pill
   must know it — check whether the pill receives prefs via InMessage today, and if not,
   add the field through the existing IPC channel).
3. Cross-platform thock audio: create/add short low-frequency "thock" clips
   (assets/audio/thock-*.wav — press, deep, release variants). Wire pill gestures ->
   new OutMessage (e.g. HapticRequest { kind }) -> desktop overlay reader ->
   audio_feedback::play, respecting playInteractionChime and rate-limiting (max N per
   100ms; drop rather than queue spam).
4. Windows/Linux pills: same IPC path (no native haptic), so behavior is uniform;
   document why macOS gets dual feedback (haptic + optionally audio) and others audio-only.
5. Ensure zero feedback when: preference off, app muted (check existing chime behavior
   for mute handling), or events are spammy (A21's hotkey filtering + your rate limiter
   must agree).
6. Tune to not overlap the existing start/stop recording chimes (different timbre or
   dedupe when both would fire for one gesture).
7. Verify no regression to A22's chevron wiring (you are after them on input.rs) and no
   audio-thread leak (A12's rules: the warm thread stays single, requests bounded).

REQUIREMENTS
- Uniform gesture->feedback mapping across platforms; preference-respecting; no new
  audio devices in pill processes; no new dependencies.
- "Thock" must feel intentional (short, low, tactile), not clicky-noise spam.

TESTS
- Rust unit tests: IPC message encode/decode for the new variant; rate-limiter logic
  (pure function: timestamps -> allowed count); audio request routing.
- Manual matrix (macOS + Windows): each gesture, preference on/off, rapid spam.

I18N
- Only if you change the chime pref description: FormattedMessage defaultMessage +
  pnpm --filter desktop i18n (keep it minimal; A19 owns copy).

DEFINITION OF DONE
- Verified thock/haptic signatures on all supported platforms (audio-only where
  haptics don't exist); preference honored; no spam/leaks; A22 chevrons still work.
- cargo fmt/clippy/test + TS checks green.

BOUNDARIES
- Second on input.rs (A22 first): additive feedback only, no gesture remapping.
  AudioDialog.tsx copy: one string at most.
```

---

## Agent A24 — AssemblyAI transcription: choose the model

**Issue (verbatim):** "Assembly AI AI transcription doesn't let you pick a model to actually transcribe with"

**Grounded context (verified):**
- Provider card config: `apps/desktop/src/components/settings/api-key-provider-config.tsx` — `STANDARD_PROVIDERS.assemblyai = { displayName: "AssemblyAI", testFn: assemblyaiTestIntegration }` with fields `[API_KEY_FIELD]` only. No model field.
- Model picker precedent: `FreeSoloModelAutocomplete.tsx` + `GroqModelPicker`/`OpenAICompatibleModelPicker`/`OpenRouterModelPicker` in settings; `ApiKeyList.tsx` renders a model autocomplete for providers that declare one (`getModelForContext`, `onModelChange`).
- Transcription provider implementation: `packages/voice-ai` (assemblyai integration, test integration); types in `packages/types`; settings state `SettingsApiKey` carries model info; CSP/remote allowlists already include AssemblyAI (no CSP change needed — verify).
- AssemblyAI offers distinct speech models (e.g. "Best", "Nano" tiers) — confirm the exact model ids against the current voice-ai integration and AssemblyAI docs.

**Owns:** `api-key-provider-config.tsx` (assemblyai entry + model field descriptor), `ApiKeyList.tsx`/`AITranscriptionConfiguration.tsx` ONLY if the model selection plumbing needs a provider-specific branch (you are SECOND there, after A05), `packages/voice-ai` assemblyai files, `packages/types` (SettingsApiKey/ApiKey model shape if needed), and the transcription call path that passes the model (trace: actions/transcriptions or sidecar/providers as the repo dictates).

```markdown
[Agent A24 — AssemblyAI model selection end to end]

MISSION
Users can pick which AssemblyAI speech model actually transcribes their audio, and that
choice is stored, validated (test integration), and passed through the transcription
pipeline — with the same UX as other providers' model pickers.

GROUND TRUTH
- api-key-provider-config.tsx: assemblyai has no model field (STANDARD_PROVIDERS +
  buildStandardConfig fields:[API_KEY_FIELD]).
- Model picker precedents: FreeSoloModelAutocomplete.tsx, GroqModelPicker,
  OpenAICompatibleModelPicker, OpenRouterModelPicker; ApiKeyList.tsx onModelChange +
  getModelForContext handle the stored model.
- packages/voice-ai implements assemblyai (transcribe + test integration);
  packages/types holds SettingsApiKey/transcription types.
- AssemblyAI domain already allowlisted in CSP/http permissions (verify; do not touch
  CSP unless a NEW domain appears — models live on the same API host).

WALK (end to end)
1. Verify the current AssemblyAI transcription path (packages/voice-ai + the desktop
   call sites): what model (if any) is passed today, and what the API default is.
   Enumerate the supported model ids (Best/Nano/etc.) from the integration code and
   current AssemblyAI docs; choose a sane default matching today's behavior.
2. Extend the provider config: assemblyai gets a model field descriptor (label, helper
   text explaining Best vs Nano tradeoffs, sensible default, free-solo autocomplete
   where other providers use one). Follow the exact pattern of an existing provider
   with a model picker (e.g. Deepgram/Groq) — DO NOT invent a parallel mechanism.
3. Persist the model in SettingsApiKey (types + state + repos) following the existing
   model storage flow; verify migration needs (if the schema stores model per key
   already for other providers, reuse it — no migration expected; confirm).
4. Pass the model through the transcription pipeline: TS action -> repo -> command /
   provider call, using the stored model when set, falling back to the default when
   not. Add validation (unknown id -> clear error, not silent default) consistent with
   other providers.
5. Update the test integration to exercise the selected model (or at least not ignore
   it) — the "Test" button should validate the key WITH the chosen model.
6. UI verification: create an AssemblyAI key, pick Nano then Best, confirm the stored
   value round-trips (reopen settings), and a real transcription uses the chosen model
   (log/echo the model in debug or verify via provider response).
7. Check CSP/allowlists: no new host => no change (document this in the report).

REQUIREMENTS
- Same UX as other providers (autocomplete + default + helper text).
- No silent fallback on invalid model ids (surface an error like other providers do).
- No changes to Deepgram/local model behavior.

TESTS
- Unit tests: config builder includes the model field; model validation logic;
  transcription call includes the stored model (mock the provider client).
- Extend packages/voice-ai tests for assemblyai model parameterization.

I18N
- New labels/helper text via FormattedMessage defaultMessage; run pnpm --filter desktop i18n.

DEFINITION OF DONE
- AssemblyAI provider card shows a working model picker; selection persists and is
  actually used by transcription; Test validates key+model; error handling on bad ids.
- check-types, lint, test (desktop + voice-ai) green.

BOUNDARIES
- Second on ApiKeyList/AITranscriptionConfiguration after A05: preserve their selected-
  outline fix. Do not change other providers' pipelines.
```

---

## 4. Wave acceptance gates

After each wave, run the WHOLE desktop + docs + touched-crates suites before the next wave starts:

```bash
pnpm run build            # all packages (turborepo)
pnpm --filter desktop check-types
pnpm --filter desktop lint
pnpm --filter desktop test
# per touched Rust crate: cargo fmt --check && cargo clippy && cargo test
pnpm --filter docs check-types   # if A20 ran
```

**Wave 1 gate:** Home has one scrollbar (A01); scroll collapse glitch gone (A02); dev surfaces only in prerelease builds (A06); slider thumb stable (A07); retranscribe feedback complete (A10); tray dashboard toggle works (A18); Register App docs live (A20); AssemblyAI model picker works (A24).

**Wave 2 gate:** selected outline visible in dark mode (A05); dictation backlog + no clipboard spam (A08); light button inner shadow corrected (A14); style selectors gated (A15); Satoshi + "Drag To Move" animation on all pills (A17).

**Wave 3 gate:** elevation helper-before-UAC + real app kill (A03); mid-dictation style switch applies on all channels (A09); silver long-press shadow (A13); light-mode shadow language mirrored (A16); pill top selector actually switches styles (A22).

**Wave 4 gate:** assistant pill renders clean text (A04); stability/memory report + provable fixes landed (A12); hotkey spam filtered (A21); thock haptics overhaul (A23). Final pass: A19's em-dash sweep re-run over the whole diff; full manual regression on the issue list.

## 5. Item → agent matrix

| # | Issue (short) | Agent | Wave | Primary files |
|---|---|---|---|---|
| 1 | Home double scrollbar | A01 | 1 | PageLayout, DashboardEntryLayout, HomePage |
| 2 | Scroll collapse glitch/leak | A02 | 1 | ScrollListPage |
| 3 | UAC startup + close-to-tray | A03 | 3 | app.rs, commands.rs, ElevationDeclinedDialog, AppSideEffects |
| 4 | Assistant pill raw markdown | A04 | 4 | assistant-mode utils, pill draw (panel) |
| 5 | Dark selected outline invisible | A05 | 2 | ApiKeyList, AITranscriptionConfiguration |
| 6 | Dev mode gating | A06 | 1 | Cargo features, tauri configs, app.rs, dev overlays |
| 7 | Slider thumb dips on hover | A07 | 1 | ElasticSlider, theme.ts (MuiSlider only) |
| 8 | Clipboard backlog / no spam | A08 | 2 | output-routing, DictationSideEffects, app.state |
| 9 | Switch style while dictating | A09 | 3 | DictationSideEffects, tone.actions |
| 10 | Retranscribe loading/completed | A10 | 1 | TranscriptRow, RetranscribeDialog, toast actions |
| 11 | Custom native context menu | A11 | (any; no shared files) | new ContextMenu + page wiring |
| 12 | Stability / memory / idle | A12 | 4 (last) | audit + provable fixes, hooks, Rust lifecycle |
| 13 | Shadow behind silver long-press | A13 | 3 | pill draw.rs/constants (long-press only) |
| 14 | Light-mode button inner shadow | A14 | 2 | shadows.ts, theme.ts (buttons) |
| 15 | Styles shown when disabled | A15 | 2 | StyleHotkeysDialog, TranscriptionsPage, RetranscribeDialog |
| 16 | Mirror shadow design into light | A16 | 3 | shadows.ts, theme.ts, TitleBar |
| 17 | Satoshi font + "Drag To Move" | A17 | 2 | pill font.rs/draw.rs (labels) |
| 18 | Tray Open/Hide Dashboard | A18 | 1 | tray.rs, commands.rs (label sync), window utils |
| 19 | Em-dashes + humanize skill | A19 | 4 (final copy pass) | copy + locales, packages/agent, scripts/prompts |
| 20 | Register App docs | A20 | 1 | apps/docs |
| 21 | Hotkey spam filter when active | A21 | 4 | AppSideEffects, DictationSideEffects (filtering) |
| 22 | Pill top style selector doesn't apply | A22 | 3 | pill input/ipc, pill_process, DictationSideEffects, tone.actions |
| 23 | Thock haptics overhaul | A23 | 4 | pill input/ipc, audio_feedback, assets/audio |
| 24 | AssemblyAI model selection | A24 | 1 | api-key-provider-config, ApiKeyList, voice-ai, types |

> A11 (context menu) is intentionally not slotted into a fixed wave — it owns a new component plus page wiring and has no shared-file conflict with any other agent; run it whenever a wave has capacity, and have A12 audit its listeners afterwards.
