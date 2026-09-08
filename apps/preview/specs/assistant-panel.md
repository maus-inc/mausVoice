# Assistant panel — compact · expanded · typing (`assistant-panel`)

- Status: **recreated** — same native process as the pill; DOM recreation from exact PANEL_* constants.
- Source of truth: `packages/rust_macos_pill/src/constants.rs` (PANEL_*), `draw.rs` panel section.
- Used in: native overlay window (assistant_compact/expanded/typing).

## Purpose
Assistant transcript/permission/review surface above the pill.

## Visual tokens
compact 424 (window 452×144) · expanded 572 (600×282) · typing 572 high (600×362) · radius 24 · bg black .96 · border white .12 · margins top 14 bottom 10 · header 10/10 right 24, buttons 28 · content inset 24 · transcript top 56 · input 48 · perm card 68, buttons 80×26 gap 6 (first +16), fill white .08 border white .15 label 11 · cards fill white .06 border white .12 · review eyebrow Satoshi 11 italic white .5, text 14 white .92, hint 11 white .45, actions row 44.

## Motion
Panel open/close + scroll fades per draw.rs (UNKNOWN exact curves — not extracted; verify in state.rs/draw.rs before animating).

## States
compact/expanded/typing × transcript/permission/review; scroll pads 12/12; keyboard button 32 gap 8.

## Accessibility
UNKNOWN: native surface contract (verify).

## Live-spec mapping
Radius + bg alpha live (recreated). Geometry patch-only: edit Rust + rebuild.

