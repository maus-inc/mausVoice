# Accordion (`accordion`)

- Status: **reused** — real MUI theme (MuiAccordion*).
- Source of truth: `apps/desktop/src/theme.ts` (MuiAccordion, Summary, Details).
- Used in: settings groups, diagnostics (any MUI Accordion).

## Purpose
Collapsible content groups.

## Visual tokens
level1, radius = shape 14, premiumSurface.rest, no :before divider, expanded margin auto. Summary 15/600 primary; details 14 secondary.

## Motion
MUI collapse tween.

## States
expanded / collapsed / disabled.

## Accessibility
MUI accordion semantics (button + region, aria-expanded).

## Live-spec mapping
Radius follows the global Shape field (live). Summary/details type patch-only.

