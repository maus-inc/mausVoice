# DESIGN.md

Durable visual decisions for the mausVoice desktop app. This is an **existing, established world** (an Operate-mode tool). Refine, preserve; do not replace.

## Surface ladder (light / dark)

Tokens live in `src/styles/palette.ts` and are wired into `src/theme.ts` (`palette` colorSchemes). 4-step elevation driven by luminance, not shadow. **Never hand-type a surface, hairline or shadow colour at a call site — import the token.**

The two schemes have their own temperature rather than being inversions of each other: light is warm **cream paper**, dark is neutral **onyx** (the old blue-cast `#14161B` ladder is gone).

| Tier              | Light (cream) | Dark (onyx) |
| ----------------- | ------------- | ----------- |
| level0 background | `#F5F2ED`     | `#0C0C0D`   |
| level1 surface    | `#FDFBF8`     | `#161617`   |
| level2 raised     | `#ECE8E1`     | `#1F1F21`   |
| level3 elevated   | `#E0DBD2`     | `#2A2A2C`   |

- **Never pure `#000` / `#fff`** for surfaces or text. Light tints from the warm ink `ink(α)` = `rgba(26,23,18,α)`; dark tints from `highlight(α)` / `onDark(α)`. The one sanctioned `#FFFFFF` is the inverted CTA fill in dark (`chalkSolid`).
- **Borders over shadows.** Cards/surfaces separated by 1px translucent hairlines — use `hairline.light(α)` / `hairline.dark(α)` from `styles/shadows.ts` (0.04–0.08). Elevation shadows (`premiumSurface`) only on layered/floating surfaces (cards, hover), not every face.
- `premiumSurface` = 2px inner top highlight (emboss) + multi‑stop soft drop shadow; distinct rest/hover/active/selected. This is the "machined keycap" treatment (Raycast class).
- Backdrop-filtered chrome uses `surfaceAlpha(tier, α)` so the translucent face can never drift from its opaque tier.

## Color (restrained — one accent)

- `primary` = warm near-black charcoal in light (`inkSolid.base` `#1A1712`), `#FFFFFF` in dark (white CTA is the primary).
- Chrome accent is **silver/ink** (`accent` in `palette.ts`: `#6B6760` / `#C4C0B8`) for focus rings, selection wash, sliders. Never hue-blue.
- Switches/toggles: grey track + black (light) / chalk (dark) thumb — not the silver accent and not blue.
- `gold` is a reward/secondary class only (inactive feature); `red` (`dangerHover`) for destructive only.
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

- Settings/deleted: 120–180ms ease‑out, exponential absorb. No **bounce** (damping < 20); snappy springs (damping ≥ 28) sanctioned for shared-layout indicators only. Reduced-motion honored everywhere (global kill-switch in `theme.ts`); keyboard‑invoked actions never animate.
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
- `decorations: false` also removes the OS resize border, so `WindowResizeHandles` supplies eight invisible edge/corner grips that hand the gesture back to the window manager.
- Every window command used by the chrome (`start-dragging`, `start-resize-dragging`, `minimize`, `maximize`, `unmaximize`, `close`) must be listed in `src-tauri/capabilities/default.json`; `core:window:default` grants none of them and the controls fail silently without them.
- Chrome glyphs are lucide nodes rendered through `MorphNavIcon` (`snappy` spring) so state swaps morph instead of cutting.

## Toasts
- sonner, bottom-right, themed via GlobalStyles bridge (`SonnerToaster.tsx`).
- Destructive actions ship UNDO. Max 4 visible; group repeats.

## Recording state machine (pill + composer)
- States: idle | recording | preview. One enum (`voiceUiState.ts`), one i18n namespace.
- Overlay actions are buttons (keyboard + focus-visible); never mouse-down-only.

## Icons
- lucide (stroke 1.9) is the only icon family. MUI icons only inside sanctioned
  third-party mockups (TutorialForm). Chrome glyphs morph via MorphNavIcon.

## Dates
- Display: Intl.DateTimeFormat(undefined, {dateStyle, timeStyle}). No dayjs format strings.

## Radius
- 7 chips/inputs · 14 cards/rows/dialogs (MUI radius 1) · 28 large dialogs · 999 pills only.
