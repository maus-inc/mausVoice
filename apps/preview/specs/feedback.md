# Progress · loading · empty states (`feedback`)

- Status: **reused** — real `AppCircularProgress`, `CenterLoading`, `CenterMessage`.
- Source of truth: `apps/desktop/src/components/common/AppCircularProgress.tsx`, `CenterLoading.tsx`, `CenterMessage.tsx`.
- Used in: no call sites found under components/ for any of the three — reserved primitives (verify before deleting).

## Purpose
Determinate/indeterminate progress; full-area loading; titled empty states with optional action.

## Visual tokens
AppCircularProgress: size/value passthrough, determinate iff value set. CenterLoading: full-height centered stack, spacing 2, pb 8. CenterMessage: flex-1 minHeight 100% centered, px 2 py 8, Container xs, stack spacing 2.

## Motion
MUI spinner animation; no custom motion.

## States
indeterminate / determinate value / loading / title-only / title+subtitle+action.

## Accessibility
Empty states are text + real action buttons. UNKNOWN: no role=status/busy wiring in source (verify).

## Live-spec mapping
Patch-only (layout in components). No known call sites.

