# Typography scale (`typography`)

- Status: **reused** — rendered with the real theme variants + `styles/fonts.css`.
- Source of truth: `apps/desktop/src/theme.ts` (typography), `apps/desktop/src/styles/fonts.css`, `apps/desktop/src/mui.d.ts` (variant overrides).
- Used in: every text surface (global).

## Purpose
One UI family (Satoshi). Tight Operate scale: display/headline/title/body/label. `tabular-nums` global; rail sidebars 224–240px, icons 22px, dense rows 32–36px.

## Visual tokens
| Variant | Size | Line-height | Weight | Spacing |
| --- | --- | --- | --- | --- |
| displayLarge/Medium/Small | 57/45/36 | 1.05/1.08/1.1 | 500 | −.02/−.02/−.015em |
| headlineLarge/Medium/Small | 32/28/24 | 1.15/1.2/1.25 | 600 | — |
| titleLarge/Medium/Small | 22/17/15 | 1.3/1.35/1.35 | 600 | — |
| bodyLarge/Medium/Small | 17/15/13 | 1.5/1.5/1.45 | 400 | — |
| labelLarge/Medium/Small | 15/13/12 | 1.3 | 600 | — |
| h5/body1/body2/button | —/15/13.5/— | —/1.55/1.5/— | 600/400/400/600 | h5 −.02em, button +.01em |

Faces: `Satoshi` (Satoshi-Medium.ttf, 100–900) for UI; `TAN-PARADISO` (woff2) only for logo wordmark + welcome/name. `--font-display` var holds the display face.

## Motion
None (static scale).

## States
All variants render in both schemes; digit stability via tabular-nums.

## Accessibility
Body measure target 65–75ch for prose; dense UI may run narrower. Never use the display face in body/settings.

## Live-spec mapping
Shape radius field is live (derived theme). Family/scale edits are patch-only: edit `theme.ts` typography + `fonts.css`, affecting all text.

