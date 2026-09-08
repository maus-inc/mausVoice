# AppTable (`table`)

- Status: **reused** — real component from `apps/desktop/src/components/common/AppTable.tsx`.
- Source of truth: `apps/desktop/src/components/common/AppTable.tsx`.
- Used in: no call sites found under components/ — reserved primitive (verify before deleting).

## Purpose
Virtualized sortable table (react-virtuoso) in Paper.

## Visual tokens
Div-based MUI table, separate borders, fixed layout; weight/fixed column widths; head cells level1, pointer + TableSortLabel when sortable.

## Motion
None (instant sort).

## States
unsorted / asc / desc / empty / footer / custom row component.

## Accessibility
Headers are clickable cells with sort labels; UNKNOWN: aria-sort wiring (MUI TableSortLabel handles direction; verify table roles in div mode).

## Live-spec mapping
Patch-only. No known call sites.

