# Native overlay pill — dictation (`native-pill`)

- Status: **recreated** — painted by a separate native process (rust_macos_pill, Cairo) outside the webview; direct reuse impossible. Canvas recreation from exact constants.
- Source of truth: `packages/rust_macos_pill/src/constants.rs`, `draw.rs`, `state.rs`, `gfx.rs`, `packages/rust_pill_shared/src/lib.rs`, `apps/desktop/src/components/root/OverlaySyncSideEffects.ts` (payload).
- Used in: native overlay window. Phases idle/recording/loading/paused; sizes dictation/assistant_compact/expanded/typing. Placement configured by PillPlacementSetting.

## Purpose
Always-on-top state surface: movement/size conveys state, not choreography.

## Visual tokens
Window 200×86 · pill area 48 · min 48×6 → expanded 120×32 · radius = min(w,h)/2 capped 16 (true capsule; cap scales with drag inflate) · bg black lerp(.6→.92, expand_t) · border white .3 inset .5px 1px. Waveform: 3 white waves (freq .8/1/1.25, mult 1.6/1.35/1.05, offsets 0/.85/1.7, opacity 1/.78/.56), stroke 1.6 round, amplitude pill_h×.75×clamp(level×mult,.03,1.3), pad pill_h×.1, alpha ×expand_t. Loading: 2px track white .15, indicator 40% white .7 (MUI-linear-progress port). Paused: centered 40% bar white .45 on track white .1. Idle hover: Satoshi 12 white “Click to dictate” (drag label “Drag To Move”). Edge gradients black .9×expand_t (left 18%, right 15%). Tooltip 172×32 r12 gap 6; flash 32 r12 gap 6 dur 2.5s; transcript 28 r10 font 12 fade 3s+6/s rise 12; long-press ring (0.92,0.95,1.0) 0.45s hold 0.12s delay; drag inflate ×1.18 (stiffness 280); cancel button 18.

## Motion
Expand spring stiffness 200. Wave phase 0.11 + 0.32×level/frame; level smoothing 0.18, decay 0.985/frame; loading 0.015/frame. UNKNOWN: expand damping ratio (not in constants) — recreation uses critical damping per “no spring-bounce on tools”; confirm against the native feel before changing.

## States
idle collapsed / idle hover label / recording wave / loading bar / paused bar / tooltip / flash / transcript / long-press ring / drag inflate.

## Accessibility
UNKNOWN: native surface — no ARIA/keyboard contract visible from the webview (verify with platform owners).

## Live-spec mapping
Expanded w/h, radius cap, active bg alpha live (recreated). Everything else patch-only: edit Rust constants + rebuild the pill process; payload shape in OverlaySyncSideEffects.

