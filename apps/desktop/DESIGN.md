# DESIGN.md

Durable visual decisions for the mausVoice desktop app. This is an **existing, established world** (an Operate-mode tool). Refine, preserve; do not replace.

## Surface ladder (light / dark)

Tokens live in `src/styles/palette.ts` and are wired into `src/theme.ts` (`palette` colorSchemes). 4-step elevation driven by luminance, not shadow. **Never hand-type a surface, hairline or shadow colour at a call site. Import the token.**

The two schemes have their own temperature rather than being inversions of each other: light is warm **cream paper**, dark is neutral **onyx** (the old blue-cast `#14161B` ladder is gone).

| Tier              | Light (cream) | Dark (onyx) |
| ----------------- | ------------- | ----------- |
| level0 background | `#F5F2ED`     | `#0C0C0D`   |
| level1 surface    | `#FDFBF8`     | `#161617`   |
| level2 raised     | `#ECE8E1`     | `#1F1F21`   |
| level3 elevated   | `#E0DBD2`     | `#2A2A2C`   |

- **Never pure `#000` / `#fff`** for surfaces or text. Light tints from the warm ink `ink(α)` = `rgba(26,23,18,α)`; dark tints from `highlight(α)` / `onDark(α)`. The one sanctioned `#FFFFFF` is the inverted CTA fill in dark (`chalkSolid`).
- **Borders over shadows.** Cards/surfaces separated by 1px translucent hairlines. Use `hairline.light(α)` / `hairline.dark(α)` from `styles/shadows.ts` (0.04-0.08). Elevation shadows (`premiumSurface`) only on layered/floating surfaces (cards, hover), not every face.
- `premiumSurface` = `insetRim` (2px inner top highlight, emboss) + multi‑stop soft drop shadow; distinct rest/hover/active/selected. This is the "machined keycap" treatment (Raycast class). `insetRim` is exported separately so a surface that has to read as a different _plane_ can borrow the rim without also borrowing the lift.
- Backdrop-filtered chrome uses `surfaceAlpha(tier, α)` so the translucent face can never drift from its opaque tier.

## Color (restrained, one accent)

- `primary` = warm near-black charcoal in light (`inkSolid.base` `#1A1712`), `#FFFFFF` in dark (white CTA is the primary).
- Chrome accent is **silver/ink** (`accent` in `palette.ts`: `#6B6760` / `#C4C0B8`) for focus rings, selection wash, sliders. Never hue-blue.
- Switches/toggles: grey track + black (light) / chalk (dark) thumb — not the silver accent and not blue.
- `gold` is a reward/secondary class only (inactive feature); `error.main` for destructive only.
- Status vocabulary must be semantic; never color-only.

## Typography

- **One family** for product UI: `uiFont = "Satoshi", system-ui`. Display face `TAN-PARADISO` only for the logo wordmark and welcome/name, never in body/settings.
- Scale is tight Operate: display/hint/title/body/label. No exaggerated contrast. Body measure target 65-75ch for prose; dense UI can run narrower.
- `tabular-nums` applied globally. Stable digit width across dates, timers, WPM, and metrics prevents side-by-side width jitter.
- Rail sidebars ~224–240px, icon 22px, dense rows 32–36px.

## Shape / spacing

- Border radius 14 for cards; controls handled via MUI components symmetric. Keep consistent. Don't mix pill/soft/hard per component.
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

## Window surfaces

The window carries one material across three surfaces: the title bar, the navigation rail and the routed content panel. `chromeWash` in `palette.ts` paints all three, one tier above the canvas with a top-lit wash so light reads as falling from the top of the window. One token for all three means they cannot be retuned into a visible step where they meet.

- The title bar and the rail are **not contiguous**. The page header sits between them, and `PageLayout` plus the rail's own padding put roughly 50px of canvas between the bar's bottom edge and the rail's top. Do not describe them as one L-shaped surface; they read as two pieces of the same material with a gap, and closing that gap is a layout change, not a token change.
- The title bar does **not** cast downward. `titleBarShadow` is a single inset bottom rim and nothing else. A shadow thrown straight down out of the bar reads as the bar hovering over the page, which is the opposite of how the window sits.
- The bar is also far more transparent than it used to be. `chromeWash` runs from 0.7 alpha down to 0.35 in light, and from 0.55 to 0.2 in dark, against the 0.88 and 0.92 fills the bar carried before. That is deliberate, and it is why the only thing separating the bar from the page is its bottom hairline. Read a see-through bar as the design, not as a bug.
- `raisedEdge` casts the rail onto the panel beside it. `recessedEdge` pushes the panel away from the rail in the opposite direction, so the two have a direction to separate in. Both are skewed sideways on purpose: a symmetrical shadow makes a rail look like it is hovering in the middle of the window.
- In dark, these two shadows do almost nothing. A near-black canvas swallows a black cast, so the separation rests entirely on the hairline borders and on the wash being one tier lighter than `level0`. If dark separation ever reads as too weak, raise the wash alpha before reaching for a stronger shadow.
- Radii follow the seam. The rail is flush against the window's left edge, so it is square there and rounded on its right; the content panel mirrors that and is rounded on its left only, which leaves one seam of canvas between the two. The panel stays square on the right and bottom so it runs into the layout padding rather than floating inside it as a card.
- Both surfaces carry a hairline only on the edge where two materials meet. The rail is full-bleed, so it draws only on its right. The panel's radius, left hairline and `recessedEdge` are responsive: below `sm` the rail is hidden, so there is no neighbour to mirror and the seam treatment steps away with it.
- Corner radius 16 for those surfaces, against 14 for cards inside the content panel. They are the largest surfaces in the window, so they carry a slightly larger radius.

## Custom chrome

- Frameless custom `TitleBar` (drag region + window controls), height 40px, all geometry in `titleBarGeometry.ts`. macOS gets traffic lights on the left; Windows and Linux get caption buttons on the right.
- Traffic lights keep a 12px painted dot inside a 24px hit box. WCAG 2.2 SC 2.5.8 measures the clickable box, not the glyph. Do not flatten them into uniform dots.
- The close button tints at `dangerHoverSoft` (0.14 alpha). The main window intercepts `CloseRequested` and hides to tray, so closing discards nothing and a full destructive fill is a false signal. The glyph keeps the shared secondary-to-primary step.
- `decorations: false` also removes the OS resize border, so `WindowResizeHandles` supplies eight invisible edge/corner grips that hand the gesture back to the window manager. With right-side caption buttons the East grip starts below the caption row and NorthEast is a `CORNER`-wide strip inside the top `EDGE` band, so diagonal resize stays reachable without reaching into the button body.
- Every window command used by the chrome (`start-dragging`, `start-resize-dragging`, `minimize`, `maximize`, `unmaximize`, `close`) must be listed in `src-tauri/capabilities/default.json`; `core:window:default` grants none of them and the controls fail silently without them.
- Chrome glyphs are lucide nodes rendered through `MorphNavIcon` (`snappy` spring) so state swaps morph instead of cutting.
- Known Tauri limitation: with `decorations: false` the window cannot be dragged while unfocused (`tauri-apps/tauri#4316`).

## Toasts

- sonner, bottom-right, themed via GlobalStyles bridge (`SonnerToaster.tsx`).
- Destructive actions ship UNDO. Max 4 visible; group repeats.

## Recording state machine (pill + composer)

- States: idle | recording | preview. Documented here; no dedicated state module.
- Overlay actions are buttons (keyboard + focus-visible); never mouse-down-only.

## Icons

- lucide (stroke 1.9) is the only icon family. MUI icons only inside sanctioned
  third-party mockups (TutorialForm). Chrome glyphs morph via MorphNavIcon.

## Dates

- Display: Intl.DateTimeFormat(undefined, {dateStyle, timeStyle}). No dayjs format strings.

## Radius

- 7 chips/inputs · 14 cards/rows/dialogs (MUI radius 1) · 28 large dialogs · 999 pills only.
