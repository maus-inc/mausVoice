# DashboardMenu sidebar rail (`dashboard-menu`)

- Status: **recreated shell** — the real menu reads the store (assistant-mode flag, update availability) + app router. Recreation copies rail wash/geometry/indicator verbatim and renders REAL ListTile + MorphNavIcon rows.
- Source of truth: `apps/desktop/src/components/dashboard/DashboardMenu.tsx`, `UpdateListTile.tsx`.
- Used in: DashboardPage, AppSideEffects.

## Purpose
Left rail navigation with a gliding active indicator.

## Visual tokens
Rail: radius 16, margin 0.35rem, hairline .05, 180deg wash (light level1 .7→level0 .35; dark level2 .55→level0 .2). List px 1.5 pb 2 pt 0.5; rows mb 0.5; selected ListItemButton forced transparent (indicator paints the fill). Indicator: absolute inset 0, radius 14, ink fill light / level2 dark, selected shadow.

## Motion
Shared-layout indicator (`layoutId="sidebar-active"`) with `springSnappy`; static box under reduced motion. Row press from ListTile.

## States
per-route selected / settings pinned bottom / update tile conditional / hover / reduced motion.

## Accessibility
Rows are ListTile buttons; indicator is pointer-events none (decorative).

## Live-spec mapping
Indicator radius live (recreated). Rail wash patch-only: edit `DashboardMenu.tsx` → DashboardPage.

