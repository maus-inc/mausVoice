# Breadcrumb (`breadcrumb`)

- Status: **reused** — real component from `apps/desktop/src/components/common/Breadcrumb.tsx`.
- Source of truth: `apps/desktop/src/components/common/Breadcrumb.tsx`.
- Used in: no call sites found under components/ — reserved primitive (verify before deleting).

## Purpose
body2 navigation trail.

## Visual tokens
Flex row gap 0.5, px 2; separator body2 secondary (default “/”); current page primary/500 ellipsis; ancestors button-links secondary, underline on hover, ellipsis.

## Motion
None (hover underline only).

## States
default / custom separator / onClick vs href navigation.

## Accessibility
Links are buttons (keyboard-focusable). UNKNOWN: no nav/aria-label or aria-current in source (flag as gap).

## Live-spec mapping
Patch-only. No known call sites.

