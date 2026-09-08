# Card · Paper (`card-paper`)

- Status: **reused** — real MUI theme (MuiCard/MuiPaper).
- Source of truth: `apps/desktop/src/theme.ts` (MuiCard, MuiPaper).
- Used in: cards, panels, table containers, wizard surfaces (global).

## Purpose
Clickable/raised card vs flat/outlined panels.

## Visual tokens
Card: level1, radius 16, hairline .05, premiumSurface.rest; default variant flat + elevation 0. Paper: default flat + elevation 0; outlined = level1 + hairline .08; flat = level1 + rest shadow + hairline .04.

## Motion
transform 180ms + shadow 200ms easeOut. Card hover: translateY(−1px) + hover shadow. Paper flat has the transition but no hover rule.

## States
default / hover (card) / outlined / flat / disabled n/a.

## Accessibility
Cards are divs; interactive cards must add role/tabindex at call sites (verify per site).

## Live-spec mapping
Card radius live. Hover/ ramp patch-only (`theme.ts` MuiCard/MuiPaper → global).

