# Elevation · premiumSurface & hairlines (`elevation`)

- Status: **reused** — shadows imported from `apps/desktop/src/styles/shadows.ts`.
- Source of truth: `apps/desktop/src/styles/shadows.ts`, `apps/desktop/src/theme.ts` (`shadows: Array(25).fill("none")` + per-component boxShadows).
- Used in: MuiButton (contained/flat), MuiFab, MuiCard, MuiPaper flat, MuiDialog, MuiPopover, MuiTooltip, MuiAccordion, MuiListItemButton selected, TitleBar (titleBarShadow); blue CTA uses accentSurface.

## Purpose
Machined-keycap treatment: 2px inner top emboss + multi-stop soft drop. Borders (1px translucent hairlines) separate faces; shadows only on layered/floating surfaces.

## Visual tokens
- `premiumSurface.{light,dark}.{rest,hover,active,selected}` — same stop geometry both schemes, mode-tuned alphas (light tinted with warm ink, dark neutral black). Light rest: inset white .42/.14 + drops ink .1/.12/.1; hover .58/.2 + .12/.16/.13; active inner ink .07 + white .18 + contact; selected .18/.06 + .2/.26. Dark rest: inset white .08/.03 + drops black .35/.35/.28; hover .12/.05 + .4/.42/.35; active inner black .45 + white .04 + contact; selected .14/.05 + .4/.45.
- `accentSurface`: same emboss, accent-tinted drop `rgba(accent, .35)` 0 6px 16px.
- `titleBarShadow`: inset bottom rim + one soft drop (light `white .3 / ink .14`; dark `white .04 / black .35`).
- `hairline`: `1px solid ink(α)` / `highlight(α)`, default α .06 (call sites use .04–.08).

## Motion
State ramps: hover > rest, active collapses to contact-only, selected heaviest. Shadow transitions 200ms easeOut where themed (buttons/cards/paper/fab).

## States
rest / hover / active / selected per scheme; parser-tested (`shadows.test.ts` — rgba-only tokens, anything else throws).

## Accessibility
Elevation is never the only signal for selection (selected rows also invert color/weight).

## Live-spec mapping
Hairline alpha is documented patch-only (baked into component borders). To persist shadow tuning: edit `styles/shadows.ts`, affecting all listed theme components.

