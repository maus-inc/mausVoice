# Design-system baseline

The shared rules that every surface must follow. This is the short, actionable
extract of [`DESIGN.md`](../DESIGN.md) — read that for the reasoning and the
full surface ladder. Applies to the React UI _and_ to the native pill, so the
two never drift apart.

## Colour

- **One accent: blue.** `palette.blue` (`#1b8af8` light / `#3198ff` dark).
  Reserved for primary actions, current selection, state indicators and
  switches. Never decoration.
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

## Interactive states

Everything interactive ships all of: default, hover, **focus-visible**, active,
disabled, and loading where relevant.

- Focus ring: designed and brand-tinted — `2px solid rgba(27, 138, 248, 0.7)`,
  `outline-offset: 2`. Never rely on the browser default.
- Press feedback: `transform: scale(0.94–0.98)` (or an inset press).
- Hover on a bare icon button also lifts the foreground to `text.primary`;
  colour alone is never the only affordance.

## Motion

- 120–180ms, ease-out. **No spring-bounce on a tool.**
- Animate specific properties. Never `transition: all`.
- `prefers-reduced-motion` is honoured globally by `MuiCssBaseline`.
- The pill is the one place where movement conveys state (recording,
  transcribing, done) rather than decoration — it still must not bounce.

## Native pill parity

The pill is drawn three times (Direct2D, Core Graphics, Cairo). Keep the three
in agreement:

- Layout maths lives in a **shared helper per crate with the same name and
  signature** — `pause_button_origin`, `cancel_button_origin`,
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
4. Verified in **both** light and dark.
5. For pill work: draw and hit-test share one helper, and the controls do not
   overlap the pill body.
