# Color · surface ladder & accents (`color`)

- Status: **reused** — rendered from `apps/desktop/src/styles/palette.ts` + `apps/desktop/src/theme.ts` colorSchemes.
- Source of truth: `apps/desktop/src/styles/palette.ts`, `apps/desktop/src/theme.ts` (colorSchemes), `apps/desktop/src/mui.d.ts` (level0–3, blue/blueHover/blueActive/onBlue).
- Used in: every themed surface (global).

## Purpose
The 4-tier surface ladder plus the single blue accent. Light is warm cream paper; dark is neutral onyx. Elevation reads from luminance + hairlines, never pure black/white.

## Visual tokens
| Token | Light | Dark |
| --- | --- | --- |
| level0 (canvas) | `#F5F2ED` | `#0C0C0D` |
| level1 (surface) | `#FDFBF8` | `#161617` |
| level2 (raised) | `#ECE8E1` | `#1F1F21` |
| level3 (elevated) | `#E0DBD2` | `#2A2A2C` |
| primary.main (CTA) | `#1A1712` inkSolid.base | `#FFFFFF` chalkSolid.base |
| blue / hover / active | `#1b8af8` / `#1a7cd4` / `#166bbf` | `#3198ff` / `#2787e6` / `#1f76cc` |
| text primary/secondary/disabled | `#1A1712` / ink(.62) / ink(.36) | `rgb(242,241,238)` / onDark(.64) / onDark(.38) |
| divider | ink(.08) | highlight(.08) |
| inkSolid raised/pressed | `#282420` / `#100E0B` | — |
| chalkSolid raised/pressed | — | `#F2F0EC` / `#FFFFFF` |

`surfaceAlpha(hex, α)` builds translucent chrome from the same hex so faces never drift. `gold` is reward-only (inactive); `red` destructive-only.

## Motion
Body background-color transitions 220ms easeOut on scheme change (`theme.ts` MuiCssBaseline).

## States
Light / dark / system (via `useColorScheme`, storage key `mui-mode`).

## Accessibility
Status vocabulary must be semantic, never color-only (DESIGN.md). Text ramps keep contrast without pure black/white extremes.

## Live-spec mapping
Each ladder/accent field targets the MUI CSS variable (`--app-palette-*`) scheme-scoped — edits recolor every themed instance site-wide. To persist: edit `styles/palette.ts` (ladder/ink/accent) or `theme.ts` (blueHover/blueActive), affecting every file in the app.

