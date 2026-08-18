# mausVoice UI/UX Deep Review — PR #63 + main, all components, with Shoogle replacements

**Branches reviewed:** `fix/superfix-review-findings` (PR #63, head `8e8fdc1`) + `main` (`e1c1df8`).
PR #63 is the superfix that integrates #55/#57/#58/#60/#59; it touches **32 desktop UI files** and **5 native pill crates** (205 added lines).
**Method:** full code read of every `apps/desktop/src/components/**` surface (167 TSX files, ~30k lines), smell-scans across the tree, then **Shoogle** (`@shoogle` registry search, same API the shadcn CLI hits: `shoogle.dev/r/search.json?q=…&type=…&limit=…` plus per-registry item JSON) to find replacement candidates — **actual source fetched, not summaries** (see Appendix A for what was fetched and how).

**Design skills fetched** (gitignored, per `.gitignore`): `.humanize/`, `.impeccable/`, `.taste/`, `.emilkowalski/`, `.ui-ux-pro-max/`, `.brandkit/`, `.design-md/` (74 brand DESIGN.md files), `.motion-ui/` (framer-motion), `.design-motion-principles/` — and used in §6 to orchestrate the unification.

---

## 1. Design read (taste v2 + impeccable)

> **Reading this as:** an **Operate-mode** desktop voice utility (impeccable's mode vocabulary: the visitor completes a task; scanability, consistency and native expectations outrank expression). Existing world: cream-paper light / neutral onyx dark surfaces, one blue accent, "machined keycap" elevation, Satoshi UI face, 14px radius, 120–180ms ease-out motion. The incumbent `apps/desktop/DESIGN.md` + `docs/design-system-baseline.md` are strong and this review treats them as the **contract**, not the subject. The UI feels "scattered" not because the tokens are weak — they're excellent — but because **12 surfaces drift from the contract** (motion, tokens, a11y, icon language, selection primitives, date formatting). §6 is the unification plan.

taste v2 explicitly scopes out dashboards/product UI (it's for landing pages/redesigns) — applied here only to the Welcome/marketing surfaces and as anti-default discipline. ui-ux-pro-max domain check (voice utility, desktop, single-accent, Satoshi) **validates the current direction**: no palette or font changes are recommended anywhere in this review.

---

## 2. Component-by-component findings (emil-design-eng review format)

Legend: **P0** = fix in PR #63 follow-up · **P1** = next sprint · **P2** = backlog.
"Shoogle alt" = registry item found via `@shoogle` search; **code** = actual source fetched (GitHub source of the registry, since registry item JSONs are served from hosts the sandbox can't reach directly — Appendix A).

### 2.1 Toast / notification — `root/SnackbarEmitter.tsx` — **P0**

**Current (mausVoice):** one global `Snackbar` driven by a zustand counter; message + mode only; `#fff` hardcoded text; raw `theme.palette.error.main` / `success.main` fills (MUI stock red/green, no tokens); no stacking, no grouping, no actions, no duration control per kind; bottom-center position (directly under the user's hands while using the pill).

| Before | After | Why |
| --- | --- | --- |
| `style={{ color: "#fff" }}` | `onX`/`success.contrastText` via theme vars | pure `#fff` is a DESIGN.md anti-pattern; token drift |
| single snackbar, counter-keyed | sonner-style stack w/ grouping + dismiss + actions (UNDO/VIEW) | destructive ops (Delete transcript, Clear local data) need UNDO; error bursts (batch import) need stacking, not replacement |
| `error.main` stock red fill | token fill from `palette.ts` (ink-derived, semantic) | one-accent policy: red = destructive only, derived not stock |
| no a11y live region semantics beyond MUI default | sonner emits `role="status"`/`alert` per toast | screen readers announce per-toast, not last-write-wins |

**Shoogle alt + fetched code:** `@mui-treasury/sonner` (mui-treasury.com, GitHub `siriwatknp/mui-treasury` → `apps/website/registry/components/sonner/sonner.tsx`) — **this is the exact bridge we need**: it wraps the `sonner` package and maps every sonner CSS variable to the MUI theme via `GlobalStyles` (`--normal-bg: palette.background.paper`, `--error-bg: palette.error.main`, `--border-radius: shape.borderRadius`, shadows, font) with `richColors`. Also `@mui-treasury/snackbar` (native MUI `SnackbarContent` w/ UNDO/VIEW action pattern) if the team wants zero new deps. Taki/Coss/ReUI/Smooth toasts (Tailwind) found via shoogle `q=toast` (12 hits) are API references only — the mui-treasury sonner bridge is adopt-as-is for an MUI app.

**Recommendation:** add `sonner` (1.3 KB gzip), adopt the mui-treasury theme-bridge file verbatim (adapted to our `cssVarPrefix: "app"`), keep the zustand `showSnackbar()` API (route it to `toast()`), move to **bottom-right** (away from pill/keyboard), add `action` support so `Delete transcript` / `Clear local data` can ship UNDO.

### 2.2 Chat surface — `chats/*` — **P0**

**ChatMessageBubble.tsx:104 "Thinking" shimmer** — animated **gradient text** (`background-clip: text` + moving gradient), 1.6s linear infinite, **not gated by `prefers-reduced-motion`**.

| Before | After | Why |
| --- | --- | --- |
| gradient-clip shimmer (DESIGN.md lists "gradient text" as anti-pattern) | pulsing ellipsis or 3-dot indicator (opacity only), or static "Thinking…" | the contract bans what this ships; opacity-only survives reduced motion |
| `1.6s linear infinite` no reduced-motion gate | gate via the §6.3 global reduced-motion kill-switch | DESIGN.md: "Reduced-motion honored everywhere" |
| assistant bubble = `action.hover` wash, no hairline | `level1` fill + 1px `hairline` border | cream-on-cream contrast; borders-over-shadows policy |
| raw `react-markdown` with ad-hoc `& pre` sx | `@mui-treasury/ai-code-block` pattern: Prism highlighting (oneLight/oneDark by color scheme), language chip, copy button | chat shows code (agent mode); copy-without-highlight is a dead end |

**Shoogle alt + fetched code:** `@mui-treasury/ai-code-block` (`ai-code-block.tsx`, 151L) — `Paper` + `react-syntax-highlighter` (Prism, oneLight/oneDark), line numbers, header slot for copy button; theme-aware via `useColorScheme`. `@mui-treasury/ai-message` (`ai-message.tsx`, 124L) — composable `Message`/`MessageContent`(contained|flat)/`MessageAvatar` primitives with `data-from` styling — a structural upgrade over the hand-rolled bubble (keeps our markdown, adds copy/retry/edit/delete action row and timestamps — currently absent). `@elevenlabs-ui/shimmering-text` (shoogle `q=shimmer`) is the same gradient-text technique — **do not adopt** (it also lacks reduced-motion handling); listed for evidence that the pattern is a community norm but not a house rule here.

**AgentActivity.tsx "Thinking…" disclosure** — `Typography onClick`: **no keyboard, no role**. Fetched `@mui-treasury/ai-reasoning` (`ai-reasoning.tsx`, 214L) is the drop-in fix: `component="button"` trigger (keyboard-accessible), Brain icon + rotating chevron (0.2s transform), **"Thought for N seconds"** duration tracking, auto-open while streaming / auto-close 1s after, context-driven sub-components. Adopt the component pattern, keep our `Collapse` content.

**ToolPermissionPrompt.tsx (also `ToolPermissionCard.tsx`, new in PR63):**

| Before | After | Why |
| --- | --- | --- |
| Deny/Allow/Always allow rendered as `Chip` with `onClick` | real `Button` (text/contained variants) | chips are not buttons: wrong role, wrong focus ring, wrong press feedback vs the app's Button language |
| pill-overlay variant: custom `OverlayButton` Box fires on `onMouseDown` only | `Button`-based with `onKeyDown` (Enter/Space) + `:focus-visible` ring | **keyboard and screen-reader users cannot allow/deny tool runs from the pill overlay today** — this is the worst a11y gap in the app |
| overlay uses `common.white`/`common.black` alpha | keep (over screenshot) but move to a named token (`overlayOnDark`) | "never pure #000/#fff" rule; one sanctioned exception must be named |

### 2.3 Audio playback — `transcriptions/AudioPlayerPill.tsx` — **P1**

Current: solid engineering (waveform downscaling, single-active-playback guard, 140ms `left` transition) but **no `role="slider"`, no keyboard scrubbing**, click-to-seek only, `transition: left` (layout prop).

Fetched `@elevenlabs-ui` (GitHub `elevenlabs/ui` → `apps/www/registry/elevenlabs-ui/ui/`, 54 components):

| component | what it adds vs ours |
| --- | --- |
| `scrub-bar.tsx` (222L) | context API; track with **`role="slider"` + `aria-valuemin/max/now`**, pointer-capture scrub with window listeners, `touch-none`, composable Track/Progress/Thumb/TimeLabel, `tabular-nums` labels |
| `audio-player.tsx` (654L) | provider + `useAudioPlayer`; **keyboard `onKeyDown` on progress** (arrows), `role="status"` spinner, play/pause `aria-label` swaps, playback-speed group (`role="group"`) |
| `waveform.tsx` (1658L) | 6 variants: `Waveform`, `ScrollingWaveform`, `AudioScrubber`, `MicrophoneWaveform`, `LiveMicrophoneWaveform`, `RecordingWaveform` — covers history playback, pill recording, composer recording in one family |
| `transcript-viewer.tsx` (419L) | word/segment-level transcript display (pairs with our segmentation) |

**Recommendation:** keep the existing pill (it's good) but (a) port the `role="slider"` + arrow-key scrubbing from `scrub-bar.tsx` (~40 lines), (b) replace `transition: left` with a transform-based progress indicator, (c) later: adopt `RecordingWaveform`/`LiveMicrophoneWaveform` for the pill & composer so all three waveform surfaces share one component family. These are Tailwind+motion; porting the logic (ARIA + pointer logic) is straightforward, the visual layer stays ours.

### 2.4 Composer voice input — `composer/*` — **P1**

Fetched `@elevenlabs-ui/speech-input.tsx` (564L) + `voice-button.tsx` (239L): record button with `aria-label` state machine (`Recording…`/`Stop recording`), explicit cancel button (`aria-label="Cancel recording"`), preview state, `forwardRef` voice button with right-side shortcut slot (our `HotkeyBadge` fits exactly). Our `voiceInstructionRecorder.ts` + `ComposerPage.tsx` already have `aria-label`s — adopt the **state-machine naming** (idle/recording/preview) as the shared enum so the pill and composer speak the same language (helps i18n + testing).

### 2.5 Microphone — `microphone/MicrophoneSelector.tsx` — **P1**

Current: `Select` + `MenuItem`, manual device list, error snackbar on load failure.
Fetched `@elevenlabs-ui/mic-selector.tsx` (284L) + `useAudioDevices()`: `enumerateDevices()` **plus `devicechange` listener** (hot-plug support — we don't react to USB/Bluetooth mics changing today), permission-request temp-stream trick to get labeled devices, `aria` on the select. **Adopt the `devicechange` subscription** (~10 lines) — real UX gap for a dictation product.

### 2.6 Hotkeys — `common/HotkeyBadge.tsx`, `common/HotKey.tsx`, `onboarding/KeybindingsForm.tsx` — **P0**

| Before | After | Why |
| --- | --- | --- |
| `HotkeyBadge`: plain bordered `Box`, text "⌘ + A" | **keycap chips**: `@mui-treasury/keycap-01` (`keycap-01.tsx`) — 3D keycap on `ButtonBase`: `&.Mui-focusVisible` 2px outline offset 2, `:active { translateY(2px) }` press, dark mode via `applyStyles` | house "machined keycap" elevation language applied where it belongs; each key its own cap = scannable combos |
| clickable badge: no `role`/`tabIndex`/`onKeyDown` | `Button` or `ButtonBase` (keystroke-cap gets button semantics) | keyboard users can't open the hotkey editor from a badge |
| `HotKey` recorder: `outline: none` + 2s infinite border-pulse (no reduced-motion gate), div w/ no role | `role="combobox"` (or `textbox`) + `aria-label` + `aria-live="polite"` for "Recording keys…"; pulse → static brand border under reduced motion; Enter/Space to start | the contract's focus-ring rule requires a designed ring, and the pulse is a reduced-motion violation |
| `KeybindingsForm` 1s infinite `borderPulse` (PR63-adjacent onboarding) | same kill-switch + static border under reduced motion | infinite decorative motion on a form |

**Shoogle alts found** (`q=hotkey`, 7 hits): ReUI `kbd`, Devl `kbd`, jal-co/ui `Keyboard Key`, Taki `kbd` (Tailwind `<kbd>` + `<KbdGroup>` — good API reference), Coss `kbd`, Vengence `Interactive Keyboard`. mui-treasury `keycap-01` is the only **MUI-native** one and matches the house aesthetic.

### 2.7 Segmented control & the "four selection languages" — **P1**

`SegmentedControl.tsx` (Tabs + layoutId spring) is the right base, but:

| Before | After | Why |
| --- | --- | --- |
| hardcoded `"rgba(255,255,255,0.05)"` hover + `"rgba(0,0,0,0.2)"` shadows | `action.hover`/`highlight(α)` + `darkInk(α)` tokens (both branches) | white-wash hover is invisible-wrong on cream; pure-black shadow breaks the token rule in light mode |
| hover not gated | `@media (hover: hover)` gate (pattern in fetched `@mui-treasury/tabs-chip-01.tsx`) | touch/pen devices get sticky hovers |
| DESIGN.md "Never spring-bounce on a tool" vs `springSnappy` in sidebar/segmented | doc fix: "no **bounce** (damping < 20); snappy springs (damping ≥ 28) sanctioned for shared-layout indicators" | doc/impl drift is what makes the UI feel scattered to contributors |

**Bigger issue — four "choose one" primitives across Settings:** `Select` (13 files), `Autocomplete` (model pickers), radio-`Chip` lists (DictationLanguageDialog), `SegmentedControl`. Unify by cardinality (rule of thumb, per ui-ux-pro-max UX guidelines): **2–4 known options → SegmentedControl; >4 or searchable → Autocomplete; >20 or server-driven → Select; single value with many → Select**. Then the settings dialogs stop being four different UIs.

### 2.8 Breadcrumb — `common/Breadcrumb.tsx` — **P2**

Fetched `@mui-treasury/breadcrumbs` (`breadcrumbs-mui-treasury.tsx`, 81L): plain MUI `Breadcrumbs` with `aria-label="breadcrumb"`, `maxItems={3}` collapse, icons. **Replace the div-soup** (no `<nav>`, no list semantics, no `aria-current="page"`) with MUI `Breadcrumbs` — 30-line change, free a11y.

### 2.9 Menus — `common/MenuPopover.tsx` — **P1**

Submenu opens **hover-only**, rendered `position: fixed` at trigger coords (no flip/clamp — clips at screen right/bottom edges), `zIndex: 1300` hardcoded, no keyboard path, child boxes `role="menuitem"` without a `role="menu"` parent.
Fix: portal the submenu, MUI `Popover` with `anchorOrigin` + collision flip (or adopt fetched shadcn-style `dropdown-menu` pattern from `@elevenlabs-ui/dropdown-menu.tsx`, 257L, which shows the sub-menu-as-second-popover + full keyboard model), `role="menu"` + `aria-haspopup`/`aria-expanded` on the parent row.

### 2.10 List rows — `common/ListTile.tsx` — **P1**

Hover-only leading/trailing actions (`display:none ↔ inline-flex`) are **unreachable by keyboard**. Fix: show on `:focus-within` too (or always show at ≤2 actions), so keyboard users get the same row. Also drop the `as any` sx cast. (Shoogle's MUI list rows — `@mui-treasury/list-item-01/02` (373L, fetched) — confirm the same approach: persistent actions or focus-within.)

### 2.11 Confirm dialogs — `common/ConfirmDialog.tsx` — **P1**

No destructive variant, no async state. Fix: `destructive?: boolean` → `color="error"` confirm button + icon; `busy?: boolean` → spinner on confirm + disabled (prevents double-click on network ops like Delete account). ~25 lines. Shoogle confirm dialogs (`q=dialog`, Radix `alert-dialog` family in `@elevenlabs-ui/alert-dialog.tsx` 214L… fetched) show the same two-prop shape.

### 2.12 Motion drift — 12 violations of the house contract — **P0/P1**

| # | File | Before | After | Why |
| --- | --- | --- | --- | --- |
| 1 | `chats/ChatMessageBubble.tsx:104` | gradient-clip shimmer 1.6s ∞ | non-gradient indicator, RM-gated | anti-pattern + reduced motion |
| 2 | `dashboard/UpdateListTile.tsx` | 3s ∞ border shimmer | static blue hairline + one-shot attention pulse | infinite decorative motion; low-frequency surface |
| 3 | `common/HotKey.tsx:164` | 2s ∞ border pulse | static 2px brand border + `aria-live` text | reduced motion + a11y |
| 4 | `onboarding/KeybindingsForm.tsx:204` | 1s ∞ borderPulse | static border | reduced motion |
| 5 | `common/SplitLayout.tsx:48` | `transition: "width 300ms ease"` | animate `flex-grow` w/ token ease ≤180ms, or grid-template-columns | layout prop + over-duration + non-token easing |
| 6 | `common/AppFab.tsx` | animates Fab `width` (ResizeObserver) | `clip-path: inset()` reveal or fixed width + `transform` | layout prop |
| 7 | `root/DashboardPage.tsx` | 220ms + `blur(2px)` route transition | 180ms ease-out, drop the blur (compositor cost) | over spec + GPU cost |
| 8 | `transcriptions/AudioPlayerPill.tsx` | `transition: "left 140ms"` | transform-based indicator | layout prop |
| 9 | `common/KeyPressSimulator.tsx:58` | `transition: all 0.1s ease-out` | named props | explicit anti-pattern |
| 10 | `common/ScrollListPage.tsx` | scroll-driven header `height` via `calc(var(--p))` | keep (iOS pattern, single header) but measure cost on long lists; cap at transform+opacity if janky | layout work per scroll frame |
| 11 | `chats/AgentActivity.tsx` | MUI `Collapse` (height) for reasoning | `grid-template-rows: 0fr→1fr` or max-height capped at content | height animation on unbounded text |
| 12 | `onboarding/BouncyTooltip.tsx` | — | **keep as-is** (already RM-gated, 0.2s) | counter-example of the house doing it right |

**Emil frequency rule applied:** anything on the dictation hotkey path (pill, composer) = 100+/day → **no animation**; settings/rows = tens/day → reduced; onboarding/welcome = rare → standard/delight allowed (VectorField stays).

### 2.13 Token/consistency drift — **P1**

| # | Where | Drift | Fix |
| --- | --- | --- | --- |
| 1 | `root/SnackbarEmitter.tsx` | `#fff` text, stock MUI red/green fills | §2.1 sonner bridge (tokens) |
| 2 | `root/TitleBar.tsx:173` | close-hover `rgba(232,77,77,0.92)` | new `dangerHover` token in `palette.ts` |
| 3 | dates | `dayjs("MMM D, YYYY h:mm A")` in `TranscriptRow` (English months in a 10-locale app!) vs `Intl.DateTimeFormat` in `UpdateSettingSection` | **Intl only**; keep dayjs for durations |
| 4 | icons | 63 files `@mui/icons-material` (filled family) vs 4 files `lucide` (stroke) — two visual families; DESIGN.md only sanctions lucide for chrome | §6.4 icon policy decision |
| 5 | radius | theme 14 vs literal `"16px"` (DashboardMenu) vs `borderRadius: 0.5/1/1.5/2` everywhere + `999` pill | §6.5 radius scale (multiples of 14) |
| 6 | `SegmentedControl` | hardcoded rgba (×2) | tokens (§2.7) |
| 7 | ad-hoc `sx` sizes (`fontSize: 13`, `py: 0.75`…) | bypass type/spacing scale | allowlist in the §6.6 lint guard |
| 8 | hex strays (verified OK) | `TutorialForm` Gmail mockup, `welcome/VectorField` | sanctioned by baseline ("artwork imitating third-party UI" / "matches web app") — keep, comments already present |

### 2.14 Native pill (PR63) — keep, with parity notes

PR63's pill work is sound: all three crates (GTK/CG/Direct2D) now report `PositionChanged { rect, monitor }` so the desktop anchors the **composer next to the real pill** (fixes the PR's own follow-up), and the Windows "clippy" is addressed. `design-system-baseline.md` parity rules (shared `*_origin` helpers, controls outside the pill body, glyph geometry as fractions of `CANCEL_BUTTON_SIZE`) are respected in the diff. One gap to close in the web half: the overlay `ToolPermissionPrompt` buttons (§2.2) sit on the pill and are the only mouse-only controls in the product — closing it completes the PR's pill/composer story.

### 2.15 Verified-strong (keep, cite as the house standard)

`AnimateIn/AnimateSwitch` (PresenceGuard `inert`+`aria-hidden`, RM fallback) · `ScrollListPage` collapse · `AudioPlayerPill` waveform engine · `EditTypography` (canvas measure, Enter/Esc) · `FadingScrollArea` · `TitleBar` (tokens, drag region, WCO, resize handles) · `ThemeModeToggle` (150ms ease-out, morph icon, i18n) · `UpdateSettingSection` (PR63: `role="status"`, `Intl` dates) · `StyleHotkeysDialog` (PR63: conflict detection, i18n) · `BouncyTooltip` (RM-gated) · `FeatureReleaseDialog`/`UpdateDialog` (state-complete) · `UpdateSettingSection`/`DictationLanguageDialog`/`MicrophoneDialog`/`DiagnosticsDialog` (read in full, no P0s).

---

## 3. PR #63 UI delta, verdict

32 UI files changed; read in full or structurally. **No new P0s introduced by PR63 itself** — its additions (`StyleHotkeysDialog`, `UpdateSettingSection`, `DialogTitleWithClose`, `ToolPermissionCard`, i18n strings for `HotkeySetting`, `AIAgentMode*`, `AITranscriptionConfiguration`) are house-standard or better. It *surfaces* two inherited P0s in the code paths it touched: `ToolPermissionCard` (chip-buttons + mouse-only overlay, §2.2) and the `TranscriptionsPage` row cluster (dates, §2.13). The 5-pill-crate geometry fix is a genuine UX win.

---

## 4. Shoogle candidate index (searched 2026-08-18)

| Query (q) | Top hits (registry → item) | Verdict for mausVoice |
| --- | --- | --- |
| `toast` (12) | @mui-treasury/sonner, @mui-treasury/snackbar · Taki Toast, ReUI Sonner, Coss Toast, Shark Toast, Smooth Basic Toast, Intent UI Toast, Watermelon Inline Toast, BeUI Toast Stack, Cult Pro Animated Toast | **adopt @mui-treasury/sonner bridge** (only MUI-native) |
| `hotkey` (7) | @mui-treasury/keycap-01 · ReUI kbd, Devl kbd, jal-co/ui Keyboard Key, Taki kbd, Coss Kbd, Vengence Interactive Keyboard | **adopt keycap-01 pattern** (MUI, matches keycap elevation) |
| `waveform` (6) | @elevenlabs-ui/waveform, @elevenlabs-ui/live-waveform · Unlumen Wave Background, ReactBits Sliced Waves, Systaliko Wavy Text, Loading UI Wave | **port ARIA/keyboard logic from elevenlabs** (voice-domain exact match) |
| `dialog` | @elevenlabs-ui/dialog, @elevenlabs-ui/alert-dialog, @mui-treasury/dialog | keep MUI Dialog; add destructive/busy props (§2.11) |
| `ai message` / `reasoning` / `code` | @mui-treasury/ai-message, ai-reasoning, ai-code-block, ai-response, ai-prompt-input, ai-tool (12 AI components) | **adopt ai-reasoning + ai-code-block patterns** (MUI) |
| `tabs` / segmented | @mui-treasury/tabs-* (10 variants incl. tabs-chip-01), @ai2/select-search, @elevenlabs-ui/tabs, toggle-group | keep SegmentedControl; tokenize + hover-gate |
| `mic` / voice | @elevenlabs-ui/mic-selector, speech-input, voice-button, voice-picker, matrix, orb | **adopt devicechange + state-machine naming** |
| `table` / `stepper` / `breadcrumb` | @mui-treasury/table, stepper, breadcrumbs | AppTable (Virtuoso) keep; **replace Breadcrumb with MUI Breadcrumbs** |
| `menu` | @elevenlabs-ui/dropdown-menu, @mui-treasury/menubar | portal+flip+keyboard for submenus (§2.9) |
| `empty state` | @ai2/empty-* (5 sets), @7ovr blocks | keep `CenterMessage`; add icon + one action (pattern ref) |

---

## 5. What was actually fetched (code, not summaries)

- **`elevenlabs/ui`** (GitHub, registry `@elevenlabs-ui`, shoogle-indexed): read `waveform.tsx` (1658L, 6 variants), `audio-player.tsx` (654L, keyboard/ARIA), `scrub-bar.tsx` (222L, `role="slider"`), `speech-input.tsx` (564L), `voice-button.tsx`, `mic-selector.tsx` (284L, `devicechange`), `transcript-viewer.tsx`, `shimmering-text.tsx`, `message.tsx`, `response.tsx`, `conversation-bar.tsx`, `dropdown-menu.tsx`, `alert-dialog.tsx`.
- **`siriwatknp/mui-treasury`** (GitHub, registry `@mui-treasury` — MUI-based): read `sonner.tsx` (theme bridge), `snackbar-mui-treasury.tsx`, `keycap-01.tsx` (3D keycap), `tabs-chip-01.tsx`, `breadcrumbs-mui-treasury.tsx`, `stepper-mui-treasury.tsx`, `table-mui-treasury.tsx`, `dialog-mui-treasury.tsx`, `list-item-01.tsx` (373L), `ai-message.tsx`, `ai-reasoning.tsx` (214L), `ai-code-block.tsx` (151L), `ai-response.tsx`. 60 components total available (12 AI/agent).
- **Shoogle search runs:** toast, hotkey, keycap, waveform, dialog, tabs, mic, menu, table, stepper, breadcrumb, empty-state (via `shoogle.dev` search route; see Appendix A for the CLI/network notes).
- **Skills** (all gitignored): emilkowalski/skills (11 skills incl. `emil-design-eng`, `review-animations`), pbakaus/impeccable (v4.1.1, 17 skill files), Leonxlnx/taste-skill (v2 + 12 variants), nextlevelbuilder/ui-ux-pro-max (v2.13.0), plugin87/ux-ui-agent-skills (brandkit + a11y-audit + apply-aesthetic…), VoltAgent/awesome-design-md (74 brand DESIGN.md files incl. elevenlabs, linear, raycast), kylezantos/design-motion-principles, jonathanhatchi/framer-motion-skill, harshaneel/humanize.

---

## 6. Unification plan — "one UI language" (orchestrated with the fetched skills)

**impeccable frame:** this is **Operate** mode; the brand lives in precise details. **Refinement, not redesign** — preserve the incumbent identity (cream/onyx, blue accent, keycap elevation, Satoshi). **design-motion-principles weighting:** Emil **primary** (productivity tool), Jakub secondary (consumer polish on Welcome/pill), Jhey selective (VectorField only). **brandkit (plugin87)** used to formalize tokens; **ui-ux-pro-max** validated direction; **humanize** reserved for UX-copy passes.

### 6.1 P0 — land with the PR63 follow-up (≈ 2–3 days)

1. **Reduced-motion kill-switch** (one `GlobalStyles` block in `theme.ts`): under `prefers-reduced-motion`, force `animation: none` on all app keyframes except opacity-only ones. Fixes findings #1–#4 in one shot; `BouncyTooltip`/`AnimateIn` keep their JS gates.
2. **ToolPermissionPrompt** → real Buttons; overlay variant gains keyboard + focus-visible (§2.2). *Worst a11y gap in the app.*
3. **HotkeyBadge** → keycap chips (mui-treasury pattern) + button semantics; **HotKey** recorder → role/aria-live/RM-static border (§2.6).
4. **Toast**: sonner + mui-treasury theme bridge, bottom-right, actions/UNDO for destructive ops (§2.1).
5. **ChatMessageBubble**: replace gradient shimmer (non-gradient, RM-safe); **AgentActivity** → button-based reasoning disclosure with duration (§2.2).
6. **Dates**: `Intl.DateTimeFormat` everywhere; drop the dayjs format strings (§2.13.3).
7. **SegmentedControl** token fix (2 hardcoded rgba) (§2.7).

### 6.2 P1 — next sprint (≈ 1 week)

8. AudioPlayerPill: `role="slider"` + arrow-key scrub + transform-based progress (§2.3).
9. MicrophoneSelector: `devicechange` hot-plug support (§2.5).
10. MenuPopover submenu: portal + flip + keyboard + `role="menu"` (§2.9).
11. ListTile: `:focus-within` reveals hover actions (§2.10).
12. ConfirmDialog: `destructive` + `busy` props (§2.11).
13. Motion items #5–#9 (SplitLayout, AppFab, DashboardPage blur, AudioPlayerPill `left`, KeyPressSimulator `all`) (§2.12).
14. Selection-primitive cardinality rule applied across Settings dialogs (§2.7).
15. Breadcrumb → MUI `Breadcrumbs` (§2.8).
16. Composer/pill: shared recorder state-machine enum (idle/recording/preview) + ElevenLabs-style `aria-label` states (§2.4).

### 6.3 P2 — backlog

17. AppTable/Stepper: no changes needed (verified strong).
18. CenterLoading `role="status"` + label; EditTypography keyboard edit entry.
19. `ai-code-block` (Prism) for chat code + message action row (copy/retry/edit/delete, timestamps).
20. Waveform family consolidation (Recording/Live variants for pill+composer).
21. ScrollListPage collapse: profile on 1k-row history; switch to transform if janky.

### 6.4 Icon policy decision (kills the biggest "scattered" feeling)

DESIGN.md currently sanctions lucide only for chrome glyphs, while 63 files use MUI's filled family. The morphing `MorphNavIcon` (lucide) is a signature interaction — **standardize on lucide (stroke 1.9)** for the whole product UI: script the ~40 MUI-icon → lucide equivalents (CheckRounded→Check, DeleteOutlineRounded→Trash2, …), keep MUI icons only inside the sanctioned Gmail/Notes mockups. One stroke weight, one optical family, morph-capable everywhere.

### 6.5 Radius + size scale (documented in DESIGN.md)

MUI `sx borderRadius: n` = n×14px — the scale is already implicit: **7 (0.5) chips/inputs · 14 (1) cards/rows · 28 (2) dialogs · 999 only for true pills**. Ban pixel literals (`"16px"` in DashboardMenu → `borderRadius: 1` + the rail's own 14). Type: no ad-hoc `fontSize: 13` — use `caption`/`body2` (13/15 already exist in the theme).

### 6.6 Guardrails so it stays unified (CI, ~1 day)

Small `scripts/ui-lint.mjs` (runs in `lint-desktop`): fails on `transition: all`, inline `ms` durations outside `styles/`, hex colors outside `styles/` + the two sanctioned artwork files, `common.white|black` outside named token wrappers, `borderRadius: "…px"` literals, dayjs display-format strings, and new `infinite` keyframes without a `useReducedMotion`/kill-switch exemption comment. Every rule in §2.12/§2.13 becomes un-failable.

### 6.7 DESIGN.md additions (paste-ready)

```md
## Toasts
- sonner, bottom-right, themed via GlobalStyles bridge (sonner/sonner.tsx pattern).
- Destructive actions ship UNDO. Max 4 visible; group repeats.

## Recording state machine (pill + composer)
- States: idle | recording | preview. One enum, one i18n namespace.
- Overlay actions are buttons (keyboard + focus-visible); never mouse-down-only.

## Icons
- lucide (stroke 1.9) is the only icon family. MUI icons only inside sanctioned
  third-party mockups (TutorialForm). Chrome glyphs morph via MorphNavIcon.

## Dates
- Display: Intl.DateTimeFormat(undefined, {dateStyle, timeStyle}). No dayjs format strings.

## Radius
- 7 chips/inputs · 14 cards/rows/dialogs (MUI radius 1) · 28 large dialogs · 999 pills only.
```

### 6.8 Token formalization (brandkit skill)

`palette.ts` is already the primitive→semantic tier. Add the missing semantics found above: `dangerHover` (232,77,77), `overlayOnDark` (sanctioned white-alpha), toast fills. Export a `tokens.css` (the theme already emits `--app-*` vars) **and feed the same file to the Rust pill crates** so web and native can never drift — the baseline doc's parity rule gets a mechanical enforcement path.

---

## Appendix A — Shoogle access notes (transparency)

- **pnpm installed** (`10.34.5`, matching the repo's `packageManager`) and `pnpm dlx shadcn@latest search @shoogle -q …` **runs**, but this sandbox's egress blocks TLS to `ui.shadcn.com`/`shoogle.dev` (`SSL_ERROR_SYSCALL`) — same for npx and curl. The shadcn CLI source (fetched from npm, v4) confirms it sends `q`, `type`, `limit`, `offset` to `https://shoogle.dev/r/search.json`.
- `shoogle.dev/r/search.json` currently **ignores `q` server-side** (returns a static default listing for any query — verified with `q=zebra`). The CLI-facing search therefore works through **shoogle's website route** `https://shoogle.dev/search?q=…`, which serves the same indexed results (used throughout §4).
- Registry item JSONs (`<registry-host>/r/<item>.json`, e.g. `https://taki-ui.com/r/kbd.json`) are fetchable but their JSX is mangled by the page proxy, and direct host fetches are egress-blocked — so **actual code was taken from the open-source GitHub repos behind each registry** (`elevenlabs/ui`, `siriwatknp/mui-treasury`; both are the registries' sources of truth).
- Scratch (clones, CLI cache) lives in gitignored `temp/`; skills in the gitignored `.<name>/` dirs already reserved in `.gitignore`.
