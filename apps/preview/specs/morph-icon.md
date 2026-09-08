# MorphNavIcon (`morph-icon`)

- Status: **reused** — real component from `apps/desktop/src/components/common/MorphNavIcon.tsx`.
- Source of truth: `apps/desktop/src/components/common/MorphNavIcon.tsx`.
- Used in: DashboardMenu, TitleBar.

## Purpose
State-swapping glyphs that morph instead of cutting.

## Visual tokens
inline-flex box size×size, svg block; MorphIcon size 22, currentColor, strokeWidth 1.85, spring “snappy”.

## Motion
morphicons snappy spring between icon nodes (e.g. Square↔Copy for maximize/restore).

## States
per-icon nodes / sizes / colors.

## Accessibility
Decorative inside labelled buttons (verify aria at call sites).

## Live-spec mapping
Patch-only → DashboardMenu + TitleBar.

