# Fab · AppFab (`fab`)

- Status: **reused** — real MuiFab theme + real `AppFab`/`AppFabPosition`.
- Source of truth: `apps/desktop/src/theme.ts` (MuiFab), `apps/desktop/src/components/common/AppFab.tsx`.
- Used in: no call sites found under components/ for AppFab (likely legacy/reserved — verify before deleting). MuiFab theme is global.

## Purpose
Extended pill CTA + auto-width content-measured AppFab with leading/trailing slots.

## Visual tokens
MuiFab: radius 99 · 18px label · padding 16/24 · icons 26px · rest shadow; info color = level2 fill. AppFab: extended, overflow hidden, label measured by ResizeObserver; contained = primary fill, outline = 1px currentColor on paper; label Stack row spacing 1, px 2, nowrap. Position: absolute bottom/right 32, row gap 2.

## Motion
MuiFab: hover −1px + hover shadow, press scale(0.98); transform 150ms + shadow 200ms easeOut. AppFab width tweens 100ms easeInOut on content change.

## States
default / hover / active / disabled / outline + contained / label-change width tween.

## Accessibility
Real buttons; extended labels are text (announced). Outline variant keeps contrast on paper.

## Live-spec mapping
Fab radius live. Motion patch-only (`theme.ts` MuiFab + `AppFab.tsx`).

