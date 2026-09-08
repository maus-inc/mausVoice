# ListTile (`list-tile`)

- Status: **reused** — real component + MuiListItemButton/MuiListItemText theme.
- Source of truth: `apps/desktop/src/theme.ts` (MuiListItemButton, MuiListItemText), `apps/desktop/src/components/common/ListTile.tsx`, `OverflowTypography.tsx`.
- Used in: MenuPopover, DashboardMenu, UpdateListTile, SettingsPage, AppStylingRow, ManualStylingRow.

## Purpose
Universal row: leading/trailing with hover swap, title/subtitle, selected state, href/cmd-click, motion indicator slot.

## Visual tokens
Button: radius 14, mb 4, minHeight 44, py 10; hover ink/highlight .04; selected light = ink fill + level1 text (primary 650) + secondary highlight .72 + selected shadow; dark = level2 + selected shadow. Primary text 550/.9375rem/−.01em. HoverButton swaps idle→icon-button (my −1, mx −1.5) on row hover; clicks stop propagation.

## Motion
bg 100ms (shortest) + transform 90ms var(--ease-out-cubic); active scale(0.975) — explicitly no will-change (tested jank-free on Apple Silicon/Intel/Win11/Linux iGPU). Reduced motion: transition none, no press scale.

## States
default / hover (swap) / selected / disabled / href (+cmd-click new tab) / leading/trailing actions / indicator slot.

## Accessibility
Real ListItemButton (button semantics, keyboard, focus-visible ring); OverflowTypography tooltips truncated titles.

## Live-spec mapping
Row radius live. Press/swap choreography patch-only: `ListTile.tsx` + `theme.ts` → six call sites.

