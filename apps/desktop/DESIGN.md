# DESIGN.md

Durable visual decisions for the mausVoice desktop app. This is an **existing, established world** (an Operate-mode tool). Refine, preserve; do not replace.

## Surface ladder (light / dark)
Palette keys in `src/theme.ts` (`palette` colorSchemes). 4-step elevation driven by luminance, not shadow.

| Tier | Light | Dark |
|------|-------|------|
| level0 background | `#F4F5F7` | `#0B0C0F` |
| level1 surface | `#FFFFFF` | `#14161B` |
| level2 raised | `#ECEEF2` | `#1E2128` |
| level3 elevated | `#E0E3E9` | `#2A2E38` |

- **Never pure `#000` / `#fff`** for surfaces. Tint toward the brand grey‑blue (`rgba(15,18,25,…` / `rgba(255,255,255,…`).
- **Borders over shadows.** Cards/surfaces separated by 1px translucent hairlines (`rgba(15,18,25,0.06)` light / `rgba(255,255,255,0.08)` dark). Elevation shadows (`premiumSurface`) only on layered/floating surfaces (cards, hover), not every face.
- `premiumSurface` = 2px inner top highlight (emboss) + multi‑stop soft drop shadow; distinct rest/hover/active/selected. This is the "machined keycap" treatment (Raycast class).

## Color (restrained — one accent)
- `primary` = near-black charcoal in light (`#12151C`), `#FFFFFF` in dark (white CTA is the primary).
- Only accent: **blue** `primary.blue #1b8af8` (light) / `#3198ff` (dark), reserved for primary actions, current selection, state indicators, switches. Not decoration.
- `gold` is a reward/secondary class only (inactive feature); `red` (hint) for destructive only.
- Status vocabulary must be semantic; never color-only.

## Typography
- **One family** for product UI: `uiFont = "Satoshi", system-ui`. Display face `TAN-PARADISO` only for the logo wordmark and welcome/name, never in body/settings.
- Scale is tight Operate — display/hint/title/body/label — no exaggerated contrast. Body measure target 65‑75ch for prose; dense UI can run narrower.
- `tabular-nums` applied globally (stable digit width across dates, timers, WPM, and metrics — prevents side-by-side width jitter).
- Rail sidebars ~224–240px, icon 22px, dense rows 32–36px.

## Shape / spacing
- Border radius 14 for cards; controls handled via MUI components semetric. Keep consistent — don't mix pill/soft/hard per component.
- 4px base spacing rhythm; generous separation around content, compact inside rows.

## Motion
- Settings/deleted: 120–180ms ease‑out, exponential absorb. Never spring‑bounce on a tool. Reduced-motion honored everywhere; keyboard‑invoked actions never animate.
- The pill is height/native channel; movement conveys state (recording, transcribing, done) not choreography.

## Micro-interactions / states
- Everything interactive: default/hover/focus‑visible/active/disabled/loading. Press feedback `scale(0.97)` (or inset press).
- Focus rings are designed, brand‑tinted, 2px offset 2.

## Themed browser surfaces
- selection, caret, scrollbar, and focus-visible themed from palette (the "built, not assembled" floor).

## Anti-patterns
- Side-stripe borders >1px; gradient text; decorative glass; `transition-all`; pure black/white; lucide-only generic icon (once stroke); ceil matching radius. See `craft-floor`.
- Emoji‑as‑icons. No.

## Custom chrome
- Frameless custom `TitleBar` (drag region + native window controls) — height ~46px, uses title BarShadow. macOS notes traffic-light inset; Windows keeps native buttons via WCO.