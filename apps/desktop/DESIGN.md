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
- `premiumSurface` = `insetRim` (2px inner top highlight, emboss) + multi‑stop soft drop shadow; distinct rest/hover/active/selected. This is the "machined keycap" treatment (Raycast class). `insetRim` is exported separately so a surface that has to read as a different _plane_ can borrow the rim without also borrowing the lift. Settings groups use the resting surface in each scheme, with their hairlines and destructive tint intact. Individual rows keep their existing interaction states rather than lifting the whole group.
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

## Home analytics

- The daily-word heatmap uses warm ember intensity ramps in `styles/palette.ts`, matching the Home reference. Its cell and grid dimensions live in `styles/activity-heatmap.ts`. It is a compact, Monday-first 53-week calendar in the Home flow, not a separate side panel. Its legend, per-day tooltips, aggregate summary, and screen-reader list expose the counts without relying on color alone. Empty and future days use distinct styling. Dated cells get a 150ms transform-only scale and outline on hover-capable fine pointers; touch has no hover state, and reduced-motion users get no scale animation. Cells are informational rather than controls, so the metric cards and count changes do not gain decorative hover, focus, or entrance motion. This keeps the reference layout still at rest and avoids animating values changed by keyboard-driven dictation.
- On wide desktop windows, the Home overview places the heatmap between two vertical metric stacks. Smaller windows put the metrics in two columns above the heatmap. The dashboard uses the available routed canvas without adding a shell-side panel or a duplicate hotkey card.

## Motion

- Settings/deleted: 120–180ms ease‑out, exponential absorb. No **bounce** (damping < 20); snappy springs (damping ≥ 28) sanctioned for shared-layout indicators only. Reduced-motion honored everywhere (global kill-switch in `theme.ts`); keyboard‑invoked actions never animate.
- The pill is height/native channel; movement conveys state (recording, transcribing, done) not choreography.

## Micro-interactions / states

- Everything interactive: default/hover/focus‑visible/active/disabled/loading. Press feedback `scale(0.97)` (or inset press).
- Focus rings are designed, brand‑tinted, 2px offset 2.
- Outlined inputs are the exception: they signal focus with the 2px charcoal border swap at the field's own radius, not a ring. That swap is the sanctioned treatment; it reads as the app's machined chrome. Do not replace it with a ring or a thinner hairline.

## Themed browser surfaces

- selection, caret, scrollbar, and focus-visible themed from palette (the "built, not assembled" floor).

## Anti-patterns

- Side-stripe borders >1px; gradient text; decorative glass; `transition-all`; pure black/white; lucide-only generic icon (once stroke); ceil matching radius; drop-shadowed in-flow cards; icon tiles behind neutral glyphs; arrows on secondary actions. See `craft-floor`.
- Native endonyms in pickers for scripts the font stack cannot render (tofu). Outside Latin/Cyrillic coverage, menus fall back to English exonyms.
- Emoji‑as‑icons. No.

## Mandatory process for UI work

Every change that touches `apps/desktop` or `apps/preview` UI runs this before the first edit. Small polish is not exempt; the generic defaults slip in on the one-line edits.

1. **Load the world.** Read this file and the design-system baseline (`docs/design-system-baseline.md`) fully into context.
2. **Load the skill sets.** The design skill sets named in the AGENTS.md skill index, currently impeccable and antislopui, including each set's floor or bans document (`craft-floor.md` for impeccable), immediately before the edit. Fetch them from their upstream sources when not vendored.
3. **Recon spree.** Gather current references for the component at hand from premium design sources and comparable shipped product UI (Dribbble, Pinterest, Attio/Linear-class pickers and the like), and pull the before/after QA-artifact screenshots for the touched surface.
4. **Weigh, then ship.** Measure every radius, slope, density, state, and label against the gathered references and this file. The committed world wins over habit.
5. **Cite.** The PR description lists the references consulted. A UI diff without them is not reviewable.

## Window surfaces

The window is a flat canvas with two chrome surfaces on it. The routed content area carries no fill, border, radius or cast of its own, so a page change is a page change and never a frame change. Only the title bar and the navigation rail paint a material, and both use `chromeWash` from `palette.ts` so they cannot be retuned into a visible step where they meet.

- The content area stays flat. A panel behind the routed page splits the window into compartments, and the rounded corner and cast that separate the compartments then read as the point of the layout. If a page needs a card inside itself, that card belongs to the page, not to the shell.
- The title bar and the rail are **not contiguous**. The page header sits between them, and `PageLayout` plus the rail's own padding put roughly 50px of canvas between the bar's bottom edge and the rail's top. Do not describe them as one L-shaped surface; they read as two pieces of the same material with a gap, and closing that gap is a layout change, not a token change.
- The title bar does **not** cast downward. `titleBarShadow` is a single inset bottom rim and nothing else. A shadow thrown straight down out of the bar reads as the bar hovering over the page, which is the opposite of how the window sits.
- The bar is also far more transparent than it used to be. `chromeWash` runs from 0.7 alpha down to 0.35 in light, and from 0.55 to 0.2 in dark, against the 0.88 and 0.92 fills the bar carried before. That is deliberate, and it is why the only thing separating the bar from the page is its bottom hairline. Read a see-through bar as the design, not as a bug.
- `raisedEdge` casts the rail onto the canvas beside it. It is skewed sideways on purpose: a symmetrical shadow makes a rail look like it is hovering in the middle of the window.
- In dark, that cast does almost nothing. A near-black canvas swallows a black shadow, so the rail separates on its hairline and on the wash being one tier lighter than `level0`. If dark separation ever reads as too weak, raise the wash alpha before reaching for a stronger shadow.
- The rail is flush against the window's left edge, square there and rounded on its right. It draws a hairline only on that right edge: the other three run into the window frame or into bare canvas, where a 1px line has nothing to separate.
- Corner radius 16 for the rail, against 14 for cards inside it, and 12 for the caption buttons.

## Window controls

The Windows and Linux caption buttons are three square targets inset from the bar edges, not three flush strips, so the bar's own material is visible between them and against the window edge. That is what separates a control cluster from a row of divider lines. Geometry lives in `titleBarGeometry.ts`, which the resize grips also read, so the cluster and the grips cannot disagree.

- Hover and press are neutral for all three, close included. `captionButtonHover` and `captionButtonActive` in `palette.ts` hold the values. A red close button advertises a destructive action, and this window intercepts `CloseRequested` to hide to tray, so nothing is discarded. Do not reintroduce a danger fill here; `error.main` stays for actions that actually destroy data.
- Each button rests at `captionButtonRestOpacity` with its glyph at `captionButtonGlyph`, and hover and press both clear that per-button dim. The cluster's separate focus dim rides the wrapper, so the two multiply: a hovered button on an unfocused window renders at the focus dim, not at full. That is intended, since a hovered button in a window the user has stepped away from should not out-shine the ones beside it. A cluster that vanished entirely would take the only visible cue that the window has controls.
- Transitions read `var(--duration-fast)` rather than a literal, so the cluster follows the same clock as the rest of the chrome and drops to 1ms under `prefers-reduced-motion`.
- Press scales the target to 0.95 and ramps the fill, rather than swapping in a gradient.
- The maximize glyph is a single wide rounded rectangle in both window states. Swapping to an overlapping restore pair mid-gesture reads as a different control, and the pair needs more width than the box it stands for, so it sits off-centre in a square target. The accessible name still changes between Maximize and Restore.
- `-webkit-corner-smoothing: 60%` keeps the rounded corners from being shaved flat by the compositor on a translucent target. It lives on `.caption-button` in `styles/caption.css`, not in the component's `sx`, because MUI's style system drops properties it does not recognise. It is a no-op on non-Chromium engines.

## Custom chrome

- Frameless custom `TitleBar` (drag region + window controls), height 40px, all geometry in `titleBarGeometry.ts`. macOS gets traffic lights on the left; Windows and Linux get caption buttons on the right.
- Traffic lights keep a 12px painted dot inside a 24px hit box. WCAG 2.2 SC 2.5.8 measures the clickable box, not the glyph. Do not flatten them into uniform dots.
- The close button tints like its neighbours. `captionButtonHover` and `captionButtonActive` in `palette.ts` hold the values, and the glyph keeps its resting colour. The main window intercepts `CloseRequested` and hides to tray, so closing discards nothing and a destructive fill is a false signal.
- `decorations: false` also removes the OS resize border, so `WindowResizeHandles` supplies eight invisible edge/corner grips that hand the gesture back to the window manager. With right-side caption buttons the East grip starts below the caption row and NorthEast is a `CORNER`-wide strip inside the top `EDGE` band, so diagonal resize stays reachable without reaching into the button body.
- Every window command used by the chrome (`start-dragging`, `start-resize-dragging`, `minimize`, `maximize`, `unmaximize`, `close`) must be listed in `src-tauri/capabilities/default.json`; `core:window:default` grants none of them and the controls fail silently without them.
- Chrome glyphs are lucide nodes rendered through `MorphNavIcon` (`snappy` spring) so state swaps morph instead of cutting.
- Known Tauri limitation: with `decorations: false` the window cannot be dragged while unfocused (`tauri-apps/tauri#4316`).

## Toasts

- sonner, bottom-right, themed via GlobalStyles bridge (`SonnerToaster.tsx`).
- Destructive actions ship UNDO. Max 4 visible; group repeats.

## Tips & inline notifications

Onboarding tips are quiet notification cards that float in the app's toast
corner, not banners anchored to a page and not plain rows either. A live tip
renders in the bottom-right tip stack (`components/onboarding/TipToaster.tsx`),
the same corner the Sonner toasts occupy, and shows only on the route the
feature lives on (`ONBOARDING_TIPS.href`) until dismissed. The Help page keeps
the in-flow listing of all five (`components/onboarding/TipCard.tsx`'s
`TipCardFrame`), dimmed for the dismissed, each with a "Show again" control in
place of a dismiss.

Why the corner and not the page. A tip anchored at the top of a page reads as
a banner pinned over the content. It competes with the page's own heading and
forces the reader to scroll around it to use the page. A nudge that can be
dismissed belongs with the other dismissible things, in the corner, out of the
reading path.

This design went through two revisions before this one. The first put tips
inline on the page as flat Linear-style rows; the owner judged that pattern
too easy to mistake for page content worth reading closely. The second moved
the row into the toast corner (the stack, the route gating, and the
`tip-actions` registry below all date from that revision and still stand).
The owner's own Paper.design board then asked for a feature-announcement
card for the live tip specifically. That card adds a header image on top of
the icon-title-body block, replacing the bare-glyph row the toast and the
Help listing had shared until now. This revision gives the live card that face
while keeping every toast-corner mechanic the second revision already proved.
The reference for the stack and the corner is Linear, Vercel, and Raycast,
which all float transient messages in a corner rather than in the content
flow. The reference for the card face is the owner's Paper.design board and
Attio's popover and picker work at `dribbble.com/shots/14651427`, both
restrained floating-card geometry with a header strip over a body. Each
choice below names what it rules out.

- **One stack, one corner, aligned with the toasts.** The tip stack anchors at
  `right: 16px; bottom: 16px`, fixed, and every card holds the Sonner toast
  column width (356px) so the two stacks line up in the corner. Live tips sit
  under the transient toasts and the MUI overlays (`z-index: 1100`): a
  confirmation toast may sit on a tip for a few seconds, a tip must never sit
  on a toast. A tip is never anchored in the page flow, and there is no second
  corner.
- **Pattern-image header on the live card, bare glyph on the listing.** One
  abstract monochrome ink pattern (`assets/tip-toast-pattern.png`), shared by
  all five tips and generated from the app's own ink/onyx/silver tokens
  (`palette.ts`), evokes a voice waveform caught mid-motion, the app's actual
  subject, rather than a stock photo or a per-tip illustration. It sits above
  the icon, title, and body, fades into the card's own `background.paper` face
  at its lower edge (built with `surfaceAlpha` against the same hex the paper
  token resolves to, so the translucent fade and the opaque body can never
  drift apart), and carries the dismiss control in a scrim chip at its
  top-right corner. The icon, title, and one-line body below keep the bare
  16px lucide glyph (stroke 1.9) at `text.secondary` with no tile, the same
  row the Help listing uses. The Help listing stays without the header image.
  The art is the live card's one moment of surprise, not something spent
  again on a list the user opens on purpose.
- **Floating face for the live tip, flat face for the listing.** A live tip
  floats over the page, so its outer card takes the floating-layer material
  the toasts use: a `background.paper` face, a 1px hairline, the standard card
  radius, and the `premiumSurface` lift, with `TipCardFrame` rendered
  transparent and borderless inside it. The Help listing is in flow, so
  `TipCardFrame` carries that flat `level1` face itself, hairline and no cast.
  There the row separates on its luminance step, per the "borders over
  shadows" rule (Raycast states it; Linear's rows carry no cast at all). One
  component supplies the copy, icons, and layout either way; only the face
  around it changes.
- **Type and measure.** `titleSmall` (-0.01em) states the claim. `body2` at
  `text.secondary` supplies the reason. Both cap at 60ch. The decision-relevant
  detail comes first. In-app cards do their job in roughly ten words.
- **One quiet action, one dismiss, now off the row.** Each tip carries at most
  one outlined pill (999) with no arrow. An arrow reads as a marketing CTA,
  and tips are not marketing. Vercel's secondary actions are quiet pills, and
  none carry arrows. More than one primary action makes it a modal, never a
  notification. Where a tip has an in-page action, the handler lives on the
  tip's own route page (the `tip-actions` registry), so the action completes
  the task in place and never dismisses the tip. Dismiss is a bare 16px X at
  `text.secondary`, now a scrim chip over the header image instead of a
  control inline in the row, so the row below stays exactly as quiet as the
  Help listing's.
- **The row itself is the activation target when there is nothing else to
  click.** A tip with no `TIP_LIVE_ACTIONS` entry has only the 24px dismiss
  glyph as an affordance otherwise, too small a target for the one thing most
  tips ask of the reader: acknowledge it and move on. `TipCardFrame` takes an
  `onActivate` prop for this case; the title-and-body row becomes a
  `role="button"`, keyboard-reachable target that marks the tip read the same
  way the X does. A tip with a live action leaves `onActivate` unset, so its
  one explicit button stays the row's only effect and a click never has to
  pick between running the action and dismissing the card.
- **Motion.** Reveal and exit run 160ms / 180ms ease-out with a 6px rise, and
  a sibling reflows with `layout` when one clears. No scale, no spring.
  Springs stay with shared-layout indicators (see Motion). Reduced motion
  drops the rise.
- **Dismissal is a choice that persists**, including when navigation
  interrupts the exit. See the `TipCard` unmount guard.
- **A live tip announces itself to a screen reader.** Sonner's own toaster
  wraps every ordinary toast in an `aria-live="polite"` region, so a
  confirmation toast is announced the moment it appears. `TipToaster` carries
  the same guarantee for a tip through its own hidden `role="status"` region,
  populated with the tip's title and body once the tip is actually on screen.
  The region itself is always mounted, even with nothing to say, since a live
  region only announces content that changes after it exists in the DOM.

## Recording state machine (pill + composer)

- States: idle | recording | preview. Documented here; no dedicated state module.
- Overlay actions are buttons (keyboard + focus-visible); never mouse-down-only.

## Icons

- lucide (stroke 1.9) is the only icon family. MUI icons only inside sanctioned
  third-party mockups (TutorialForm). Chrome glyphs morph via MorphNavIcon.

## Dates

- Display: Intl.DateTimeFormat(undefined, {dateStyle, timeStyle}). No dayjs format strings.

## Radius

- 7 chips · 14 cards/rows/dialogs/inputs (MUI radius 1) · 28 large dialogs · 999 pills only.
