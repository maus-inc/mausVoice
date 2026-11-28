# Design-system baseline

The shared rules that every surface must follow. This is the short, actionable
extract of [`DESIGN.md`](../DESIGN.md). Read that for the reasoning and the
full surface ladder. Applies to the React UI _and_ to the native pill, so the
two never drift apart.

## Colour

- **One accent: silver/ink chrome.** `palette.chrome` (`#6B6760` light /
  `#C4C0B8` dark). Focus rings, selection wash, sliders. Switches use
  ink/chalk, not this metal. Never hue-blue. Never decoration.
- **Never hard-code a mode-specific colour.** Use a palette token
  (`theme.vars.palette.*`, or `var(--app-palette-*)` inside `keyframes` and
  other strings that cannot see the theme object).
- **Never branch on `theme.palette.mode` inside `styleOverrides`.** That value
  is resolved once when the theme is built, so it freezes styling to whichever
  scheme loaded first. Use `theme.applyStyles("dark", { ... })`, which compiles
  to a `[data-mui-color-scheme="dark"]` selector and switches live.
- Surfaces come from the level ladder (`level0`–`level3`), never pure
  `#000`/`#fff`.
- Literal colours are acceptable in exactly one case: artwork that deliberately
  imitates a third-party UI (for example the Notes/Gmail mock-ups in
  `TutorialForm`). Comment why.

## Icons

- **One family: lucide at stroke 1.9.** MUI icons survive only inside the
  sanctioned third-party mock-ups. A Material glyph next to a lucide glyph in
  the same pane is the defect this rule exists to catch, and it is visible
  without measuring anything. The settings surface is held to this end to end,
  dialogs and pickers included, by `settings-row-icon-coverage.test.ts`.
- **One size per context.** 22px for the glyphs that lead rows and rail items
  (spread from the shared `settingGlyphProps`/rail constants, never a per-call
  literal), 20px for chevrons, 18px for a mark inside an action pill, and 16px
  for the settings search field's magnifier (`settingSearchGlyphProps`) or a
  mark inside body copy. Provider marks are brand artwork via `ProviderLogo`,
  at the same 22px box. One stroke everywhere: 1.9, from the shared props.
  Lucide's own default is 2, so a glyph that omits `strokeWidth` is a defect
  even when its size is right, and `settings-row-icon-coverage.test.ts` reads
  every imported lucide element in the folder to catch one.
- **Settings rows all lead with a glyph**, on `SettingRow` and
  `SettingToggleRow` alike, in one lane whose width has a floor of the glyph
  size, so titles align. Two marks are identity rather than icon and are the
  standing exceptions: a provider's own artwork via `ProviderLogo`, and the
  person's avatar. A wider mark widens its own lane rather than being centred
  through its neighbours; centring it in a fixed 22px lane left a 48px avatar
  3px from the card edge and 3px from its title. Glyphs are `aria-hidden`, and
  so is a mark inside an action pill; the accessible name is the title plus,
  for a pill, its verb. Colour is `text.secondary`, lifted to `error.main` only
  for a destructive row.
- **No icon tiles.** A neutral glyph never sits on a filled square, and no
  glyph is tinted to carry emphasis that belongs to the title or the control.
- Rows whose leading content is a key (the hotkey chips in the shortcuts
  summary and dialog) are not settings and stay iconless.

## Interactive states

Everything interactive ships all of: default, hover, **focus-visible**, active,
disabled, and loading where relevant.

- Focus ring: designed and chrome-tinted — `2px solid` silver/ink at ~70%
  (`accent` RGB), `outline-offset: 2`. Never rely on the browser default.
- Press feedback: `transform: scale(0.94–0.98)` (or an inset press).
- Hover on a bare icon button also lifts the foreground to `text.primary`;
  colour alone is never the only affordance.

## Motion

- 120–180ms, ease-out. **No spring-bounce on a tool.**
- Animate specific properties. Never `transition: all`.
- `prefers-reduced-motion` is honoured globally by `MuiCssBaseline`.
- The pill is the one place where movement conveys state (recording,
  transcribing, done) rather than decoration. It still must not bounce.

## Layout and scrolling

- **The window never scrolls.** `MuiCssBaseline` clips `html` and `body`, and
  `AppViewport` is the only viewport-sized box, sized from the `100%` chain
  rather than `100dvh`/`100vw`.
- **Each route owns its scroll.** A surface that needs room puts
  `overflow-y: auto` on a box that is already constrained. Never re-enable the
  document scroller to make one page fit.
- **Settings layout responds to its own content width.** At a 680px
  container width, use a 208px side rail and a 32px gap, leaving 416px for the
  reading column after the 24px outer inset. Below that threshold, wrap the
  navigation links above the content instead of horizontally scrolling them.
- **Sighted-silent content imports `visuallyHidden`** from `styles/a11y.ts`
  instead of copying the declaration set. The helper pins the clipped box with
  `top` and `left`; an unpinned box keeps its static position and the last
  pixel of it opens a window scrollbar.

## Native pill parity

The pill is drawn three times (Direct2D, Core Graphics, Cairo). Keep the three
in agreement:

- Layout maths lives in a **shared helper per crate with the same name and
  signature**. `pause_button_origin`, `cancel_button_origin`,
  `over_side_control`, `long_press_progress`. Draw code and hit-testing must
  both call them, so a control can never be painted somewhere it cannot be
  clicked.
- Side controls sit **fully outside** the pill body (`CONTROL_EDGE_GAP`).
  Overlapping controls steal presses from the pill itself, which is what
  starts and stops dictation.
- Pause/resume on the **left**, cancel on the **right**, both vertically
  centred on the pill.
- Glyph geometry is expressed as a fraction of `CANCEL_BUTTON_SIZE`, not as
  absolute pixels, so the icons stay balanced at every scale.
- Long-press: nothing is drawn for the first `LONG_PRESS_HOLD_DELAY`, so a
  normal click never flashes an affordance; progress then ramps to 1.0 at
  `LONG_PRESS_DURATION`.

## Checklist for a new surface

1. Colours come from tokens; no `palette.mode` branch in `styleOverrides`.
2. Hover, focus-visible and active states are all present.
3. Motion is 120–180ms ease-out on named properties.
4. Verified in **both** light and dark, with one scrollbar per direction and no
   scrollbar on the window itself.
5. For pill work: draw and hit-test share one helper, and the controls do not
   overlap the pill body.
6. Stageshow walked: `.agents/skills/stageshow/references/craft.md` read before the
   edit, the `verify.md` You see / You do table checked against the surface in both
   themes, and every line that would print (`tight inset:`, `fat row:`, `empty pane:`,
   `mixed icons:`, `anchor drift:` and the rest) fixed or explained with the state it
   was seen in. Applies to the React UI, the native pill and any picture of either.
7. Every row you added or edited in Settings leads with a lucide glyph from the
   shared props, in the shared lane, with no tile behind it.
