# IconButton (`icon-button`)

- Status: **reused** — real MUI IconButton + theme overrides.
- Source of truth: `apps/desktop/src/theme.ts` (MuiIconButton).
- Used in: close buttons, trailing actions, AudioPlayerPill, CopyableCommand, ListTile hover buttons.

## Purpose
Compact square-ish action hit area.

## Visual tokens
Radius 12 · text.primary · ripple off · hover level2 fill.

## Motion
transform 120ms + bg 180ms easeOut; press scale(0.96).

## States
default / hover / focus-visible / active / disabled / loading (disabled + spinner pattern).

## Accessibility
Requires `aria-label` at every call site (icon-only). 28–48px targets depending on size prop.

## Live-spec mapping
Radius live. Press scale patch-only (`theme.ts` MuiIconButton → all icon buttons).

