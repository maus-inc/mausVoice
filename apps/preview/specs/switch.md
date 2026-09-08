# Switch — square (`switch`)

- Status: **reused** — real MUI Switch + theme overrides.
- Source of truth: `apps/desktop/src/theme.ts` (MuiSwitch).
- Used in: every MUI Switch in settings/onboarding (global).

## Purpose
Binary setting toggle with the square shadcn switch-2 look.

## Visual tokens
Thumb radius 3 · track radius 5 · checked thumb+track blue (both switchBase and track rules).

## Motion
MUI default switch tween (theme unmodified).

## States
on / off / disabled on/off / focus-visible (global ring) / hover.

## Accessibility
Native checkbox semantics; keyboard toggling via MUI; label via FormControlLabel or inputProps aria-label at call sites.

## Live-spec mapping
Track + thumb radii live (derived theme → every Switch).

