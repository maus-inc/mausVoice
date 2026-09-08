/**
 * Generates apps/preview/specs/*.md — one human-editable spec file per
 * registry entry. Re-run with `pnpm --filter @maus-inc/preview gen:specs`
 * after editing THIS script. Direct edits to specs/*.md are preserved
 * unless the generator is re-run (it overwrites).
 *
 * Every value below is copied from the cited source file. Anything not
 * derivable is marked UNKNOWN.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "specs");
mkdirSync(root, { recursive: true });

const D = "apps/desktop/src";

/** [id, markdown] */
const SPECS = [
["color", `# Color · surface ladder & accents (\`color\`)

- Status: **reused** — rendered from \`${D}/styles/palette.ts\` + \`${D}/theme.ts\` colorSchemes.
- Source of truth: \`${D}/styles/palette.ts\`, \`${D}/theme.ts\` (colorSchemes), \`${D}/mui.d.ts\` (level0–3, blue/blueHover/blueActive/onBlue).
- Used in: every themed surface (global).

## Purpose
The 4-tier surface ladder plus the single blue accent. Light is warm cream paper; dark is neutral onyx. Elevation reads from luminance + hairlines, never pure black/white.

## Visual tokens
| Token | Light | Dark |
| --- | --- | --- |
| level0 (canvas) | \`#F5F2ED\` | \`#0C0C0D\` |
| level1 (surface) | \`#FDFBF8\` | \`#161617\` |
| level2 (raised) | \`#ECE8E1\` | \`#1F1F21\` |
| level3 (elevated) | \`#E0DBD2\` | \`#2A2A2C\` |
| primary.main (CTA) | \`#1A1712\` inkSolid.base | \`#FFFFFF\` chalkSolid.base |
| blue / hover / active | \`#1b8af8\` / \`#1a7cd4\` / \`#166bbf\` | \`#3198ff\` / \`#2787e6\` / \`#1f76cc\` |
| text primary/secondary/disabled | \`#1A1712\` / ink(.62) / ink(.36) | \`rgb(242,241,238)\` / onDark(.64) / onDark(.38) |
| divider | ink(.08) | highlight(.08) |
| inkSolid raised/pressed | \`#282420\` / \`#100E0B\` | — |
| chalkSolid raised/pressed | — | \`#F2F0EC\` / \`#FFFFFF\` |

\`surfaceAlpha(hex, α)\` builds translucent chrome from the same hex so faces never drift. \`gold\` is reward-only (inactive); \`red\` destructive-only.

## Motion
Body background-color transitions 220ms easeOut on scheme change (\`theme.ts\` MuiCssBaseline).

## States
Light / dark / system (via \`useColorScheme\`, storage key \`mui-mode\`).

## Accessibility
Status vocabulary must be semantic, never color-only (DESIGN.md). Text ramps keep contrast without pure black/white extremes.

## Live-spec mapping
Each ladder/accent field targets the MUI CSS variable (\`--app-palette-*\`) scheme-scoped — edits recolor every themed instance site-wide. To persist: edit \`styles/palette.ts\` (ladder/ink/accent) or \`theme.ts\` (blueHover/blueActive), affecting every file in the app.
`],
["typography", `# Typography scale (\`typography\`)

- Status: **reused** — rendered with the real theme variants + \`styles/fonts.css\`.
- Source of truth: \`${D}/theme.ts\` (typography), \`${D}/styles/fonts.css\`, \`${D}/mui.d.ts\` (variant overrides).
- Used in: every text surface (global).

## Purpose
One UI family (Satoshi). Tight Operate scale: display/headline/title/body/label. \`tabular-nums\` global; rail sidebars 224–240px, icons 22px, dense rows 32–36px.

## Visual tokens
| Variant | Size | Line-height | Weight | Spacing |
| --- | --- | --- | --- | --- |
| displayLarge/Medium/Small | 57/45/36 | 1.05/1.08/1.1 | 500 | −.02/−.02/−.015em |
| headlineLarge/Medium/Small | 32/28/24 | 1.15/1.2/1.25 | 600 | — |
| titleLarge/Medium/Small | 22/17/15 | 1.3/1.35/1.35 | 600 | — |
| bodyLarge/Medium/Small | 17/15/13 | 1.5/1.5/1.45 | 400 | — |
| labelLarge/Medium/Small | 15/13/12 | 1.3 | 600 | — |
| h5/body1/body2/button | —/15/13.5/— | —/1.55/1.5/— | 600/400/400/600 | h5 −.02em, button +.01em |

Faces: \`Satoshi\` (Satoshi-Medium.ttf, 100–900) for UI; \`TAN-PARADISO\` (woff2) only for logo wordmark + welcome/name. \`--font-display\` var holds the display face.

## Motion
None (static scale).

## States
All variants render in both schemes; digit stability via tabular-nums.

## Accessibility
Body measure target 65–75ch for prose; dense UI may run narrower. Never use the display face in body/settings.

## Live-spec mapping
Shape radius field is live (derived theme). Family/scale edits are patch-only: edit \`theme.ts\` typography + \`fonts.css\`, affecting all text.
`],
["elevation", `# Elevation · premiumSurface & hairlines (\`elevation\`)

- Status: **reused** — shadows imported from \`${D}/styles/shadows.ts\`.
- Source of truth: \`${D}/styles/shadows.ts\`, \`${D}/theme.ts\` (\`shadows: Array(25).fill("none")\` + per-component boxShadows).
- Used in: MuiButton (contained/flat), MuiFab, MuiCard, MuiPaper flat, MuiDialog, MuiPopover, MuiTooltip, MuiAccordion, MuiListItemButton selected, TitleBar (titleBarShadow); blue CTA uses accentSurface.

## Purpose
Machined-keycap treatment: 2px inner top emboss + multi-stop soft drop. Borders (1px translucent hairlines) separate faces; shadows only on layered/floating surfaces.

## Visual tokens
- \`premiumSurface.{light,dark}.{rest,hover,active,selected}\` — same stop geometry both schemes, mode-tuned alphas (light tinted with warm ink, dark neutral black). Light rest: inset white .42/.14 + drops ink .1/.12/.1; hover .58/.2 + .12/.16/.13; active inner ink .07 + white .18 + contact; selected .18/.06 + .2/.26. Dark rest: inset white .08/.03 + drops black .35/.35/.28; hover .12/.05 + .4/.42/.35; active inner black .45 + white .04 + contact; selected .14/.05 + .4/.45.
- \`accentSurface\`: same emboss, accent-tinted drop \`rgba(accent, .35)\` 0 6px 16px.
- \`titleBarShadow\`: inset bottom rim + one soft drop (light \`white .3 / ink .14\`; dark \`white .04 / black .35\`).
- \`hairline\`: \`1px solid ink(α)\` / \`highlight(α)\`, default α .06 (call sites use .04–.08).

## Motion
State ramps: hover > rest, active collapses to contact-only, selected heaviest. Shadow transitions 200ms easeOut where themed (buttons/cards/paper/fab).

## States
rest / hover / active / selected per scheme; parser-tested (\`shadows.test.ts\` — rgba-only tokens, anything else throws).

## Accessibility
Elevation is never the only signal for selection (selected rows also invert color/weight).

## Live-spec mapping
Hairline alpha is documented patch-only (baked into component borders). To persist shadow tuning: edit \`styles/shadows.ts\`, affecting all listed theme components.
`],
["motion", `# Motion tokens & transitions (\`motion\`)

- Status: **reused** — values from \`${D}/styles/motion.ts\` + \`theme.ts\` transitions + \`fonts.css\` vars.
- Source of truth: \`${D}/styles/motion.ts\`, \`${D}/theme.ts\` (transitions), \`${D}/styles/fonts.css\` (:root vars).
- Used in: AnimateIn/AnimateSwitch, SegmentedControl, DashboardMenu, DashboardPage, TutorialForm, UnlockedProForm, ElasticSlider, ListTile, AppFab, AppStepper, ThemeModeToggle, HotKey.

## Purpose
Emil Kowalski-grade timing: purposeful cubic-beziers, springs for chrome/shared-layout, tweens for fades/presses. Tool rule: 120–180ms ease-out, no spring-bounce; keyboard-invoked actions never animate; reduced motion honored everywhere.

## Visual tokens
Durations: shortest 100 · shorter 150 · short 180 · standard 220 · complex 280 · enteringScreen 250 · leavingScreen 180 (ms). motion.ts mirrors in seconds: instant .1 · fast .15 · base .2 · enter .25 · exit .18. Easings: easeOut \`cubic-bezier(0.23,1,0.32,1)\` · sharp \`cubic-bezier(0.33,1,0.68,1)\` · easeInOut \`cubic-bezier(0.645,0.045,0.355,1)\`. Springs: snappy \`{420, 32, 0.8}\` · soft \`{280, 28, 0.9}\`. CSS vars: \`--ease-out-quint/cubic/in-out\`, \`--duration-fast/base/enter/exit\`.

## Motion
Springs drive AnimateIn/AnimateSwitch enter-exit, segmented + sidebar shared-layout indicators. Tweens drive press feedback (scale .96–.98, 90–150ms), hovers (150–200ms), dialog/popover enter/exit (250/180ms).

## States
Full motion / reduced motion (springs → opacity fades; ListTile transitions off; bounce dropped; AnimateSwitch renders keyed static).

## Accessibility
\`prefers-reduced-motion\` honored in every animated component; global CSS kill-switch in MuiCssBaseline; keyboard-invoked actions skip animation.

## Live-spec mapping
All duration/easing fields are live (derived theme) — framer-motion springs read from \`motion.ts\` are patch-only (edit constants, rebuild). Persist: \`theme.ts\` transitions + \`motion.ts\`, affecting all listed consumers.
`],
["animate", `# AnimateIn · AnimateSwitch (\`animate\`)

- Status: **reused** — real components from \`${D}/components/common/AnimateIn.tsx\`.
- Source of truth: \`${D}/components/common/AnimateIn.tsx\`, \`${D}/styles/motion.ts\`.
- Used in: \`${D}/components/settings/AIPostProcessingConfiguration.tsx\`, \`${D}/components/settings/AITranscriptionConfiguration.tsx\`.

## Purpose
Appear/disappear wrapper (AnimateIn) and mutually-exclusive section crossfade (AnimateSwitch, \`mode="wait"\`).

## Visual tokens
No paint of its own; animates opacity/y/scale on a full-width motion.div.

## Motion
AnimateIn: initial \`{opacity 0, y 6, scale .99}\`, exit \`{y −6}\`, \`springSnappy\`; reduced motion → bare opacity fade with \`duration.exit\`. AnimateSwitch: y 8, same spring; reduced motion renders keyed static div (no AnimatePresence).

## States
visible on/off; activeKey swaps; reduced-motion fallbacks.

## Accessibility
Outgoing content wrapped in \`inert\` + \`aria-hidden\` (PresenceGuard) so exiting copies can't be clicked, focused, or read.

## Live-spec mapping
Patch-only (choreography lives in the component). Persist: edit \`AnimateIn.tsx\` / \`motion.ts\`, affecting the two settings configurations.
`],
["button", `# Button — contained · text · flat · blue (\`button\`)

- Status: **reused** — real MUI Button + real theme overrides.
- Source of truth: \`${D}/theme.ts\` (MuiButton).
- Used in: every MUI Button app-wide (dialog actions, forms, onboarding, settings).

## Purpose
Primary actions. contained = main CTA (ink/white); text = quiet; flat = machined surface; blue = the single accent CTA.

## Visual tokens
Root: radius 12 · 600 · 15px · padding 8/16 · icons 22px · ripple off · elevation off. contained: ink base/\`#FDFBF8\` text (light), white/\`#0C0C0D\` (dark); flat: level1→2→3; blue: blue/blueHover/blueActive + onBlue text + accentSurface. Hover: contained/flat lift −1px + hover shadow; text hovers level2, actives level3.

## Motion
Root transition: transform 120ms + bg/color 180ms + shadow 200ms, all easeOut. Press: scale(0.97) root; contained/flat/blue press scale(0.98) + active shadow. No input blocking; hover responds on pointerenter.

## States
default / hover / focus-visible (global 2px brand ring, offset 2) / active / disabled (MUI) / loading (app pattern: disabled + spinner + label swap).

## Accessibility
Real \`<button>\`; disabled state announced; focus-visible ring designed (accent-tinted, 2px, offset 2). Loading keeps the label live text.

## Live-spec mapping
Radius is live (derived theme → every Button). Font/press values patch-only: edit \`theme.ts\` MuiButton, affecting all buttons.
`],
["icon-button", `# IconButton (\`icon-button\`)

- Status: **reused** — real MUI IconButton + theme overrides.
- Source of truth: \`${D}/theme.ts\` (MuiIconButton).
- Used in: close buttons, trailing actions, AudioPlayerPill, CopyableCommand, ListTile hover buttons.

## Purpose
Compact square-ish action hit area.

## Visual tokens
Radius 12 · text.primary · ripple off · hover level2 fill.

## Motion
transform 120ms + bg 180ms easeOut; press scale(0.96).

## States
default / hover / focus-visible / active / disabled / loading (disabled + spinner pattern).

## Accessibility
Requires \`aria-label\` at every call site (icon-only). 28–48px targets depending on size prop.

## Live-spec mapping
Radius live. Press scale patch-only (\`theme.ts\` MuiIconButton → all icon buttons).
`],
["fab", `# Fab · AppFab (\`fab\`)

- Status: **reused** — real MuiFab theme + real \`AppFab\`/\`AppFabPosition\`.
- Source of truth: \`${D}/theme.ts\` (MuiFab), \`${D}/components/common/AppFab.tsx\`.
- Used in: no call sites found under components/ for AppFab (likely legacy/reserved — verify before deleting). MuiFab theme is global.

## Purpose
Extended pill CTA + auto-width content-measured AppFab with leading/trailing slots.

## Visual tokens
MuiFab: radius 99 · 18px label · padding 16/24 · icons 26px · rest shadow; info color = level2 fill. AppFab: extended, overflow hidden, label measured by ResizeObserver; contained = primary fill, outline = 1px currentColor on paper; label Stack row spacing 1, px 2, nowrap. Position: absolute bottom/right 32, row gap 2.

## Motion
MuiFab: hover −1px + hover shadow, press scale(0.98); transform 150ms + shadow 200ms easeOut. AppFab width tweens 100ms easeInOut on content change.

## States
default / hover / active / disabled / outline + contained / label-change width tween.

## Accessibility
Real buttons; extended labels are text (announced). Outline variant keeps contrast on paper.

## Live-spec mapping
Fab radius live. Motion patch-only (\`theme.ts\` MuiFab + \`AppFab.tsx\`).
`],
["switch", `# Switch — square (\`switch\`)

- Status: **reused** — real MUI Switch + theme overrides.
- Source of truth: \`${D}/theme.ts\` (MuiSwitch).
- Used in: every MUI Switch in settings/onboarding (global).

## Purpose
Binary setting toggle with the square shadcn switch-2 look.

## Visual tokens
Thumb radius 3 · track radius 5 · checked thumb+track blue (both switchBase and track rules).

## Motion
MUI default switch tween (theme unmodified).

## States
on / off / disabled on/off / focus-visible (global ring) / hover.

## Accessibility
Native checkbox semantics; keyboard toggling via MUI; label via FormControlLabel or inputProps aria-label at call sites.

## Live-spec mapping
Track + thumb radii live (derived theme → every Switch).
`],
["slider", `# ElasticSlider (\`slider\`)

- Status: **reused** — real component from \`${D}/components/common/ElasticSlider.tsx\`.
- Source of truth: \`${D}/components/common/ElasticSlider.tsx\`.
- Used in: \`${D}/components/settings/AppKeybindingsDialog.tsx\`, \`${D}/components/settings/AudioDialog.tsx\`.

## Purpose
Accent-filled slider with a blooming thumb and 1:1 drag tracking (local drag value; \`onCommit\` on release/keyboard).

## Visual tokens
Rail/track 4px radius 99 (rail level3, track blue, no border) → 6px on container hover (160ms easeOut). Thumb 16px white circle, 2px blue ring, \`0 1px 3px rgba(0,0,0,.25)\`; hover scale 1.15 + 6px blue 14% halo; drag scale 1.25 + 8px blue 18% halo; focus-visible 3px blue 40% ring. Thumb transforms must re-compose \`translate(-50%,-50%)\` (THUMB_CENTER_TRANSFORM).

## Motion
Thumb transform/shadow 160ms easeOut; container \`whileTap: scale 1.015\` spring {500, 30} — static plain div under reduced motion.

## States
default / hover / drag / keyboard / focus-visible / disabled (MUI) / value-label auto.

## Accessibility
MUI Slider semantics: \`aria-label\` prop, arrow-key support, value text via valueLabelFormat. onCommit (not onChange) persists — screen-reader announcements follow MUI value text.

## Live-spec mapping
Patch-only (sx builder in the component). Persist: edit \`ElasticSlider.tsx\` → the two settings dialogs.
`],
["segmented", `# SegmentedControl (\`segmented\`)

- Status: **reused** — real component from \`${D}/components/common/SegmentedControl.tsx\`.
- Source of truth: \`${D}/components/common/SegmentedControl.tsx\`, \`${D}/styles/motion.ts\`.
- Used in: AIAgentMode/AIPostProcessing/AITranscription configurations, MoreSettingsDialog, PillPlacementSetting.

## Purpose
Track of mutually exclusive options (Off/API/Local patterns) with a sliding indicator.

## Visual tokens
Track: inline-flex, action.hover fill, radius 2 (16px), p 0.5, 1px divider border. Tabs: no indicator; tab radius 1.5 (12px), py 1.25 px 2.5, 600, secondary → primary selected; unselected hover primary + white 5% wash. Indicator: absolute inset 0, radius 12, paper fill, \`inset 0 1px 3px rgba(0,0,0,.2), 0 1px 2px rgba(0,0,0,.05)\`.

## Motion
Shared-layout indicator (\`layoutId\` per instance via useId) with \`springSnappy\`; reduced motion renders a static pill. align start/center only changes track self-placement.

## States
selected / unselected / hover / disabled option / keyboard (MUI Tabs arrows) / focus-visible.

## Accessibility
MUI Tabs semantics + \`ariaLabel\` prop; arrow-key navigation; selected tab exposed via aria-selected.

## Live-spec mapping
Patch-only. Persist: edit \`SegmentedControl.tsx\` → the five settings call sites.
`],
["text-field", `# TextField · Checkbox · Select theme defaults (\`text-field\`)

- Status: **reused** — stock MUI v9 on the real theme (no overrides exist).
- Source of truth: \`${D}/theme.ts\` (absence of overrides is the spec), \`${D}/components/common/Section.tsx\` (checkbox toggle pattern).
- Used in: login/signup, onboarding UserDetailsForm, settings provider fields, dictionary AddTermDialog.

## Purpose
Text entry + selection controls. UNKNOWN: no custom spec — renders MUI defaults in Satoshi on the ladder.

## Visual tokens
MUI v9 outlined defaults; small size typical in settings; error/disabled/focused states stock.

## Motion
MUI defaults (label float, ripple on checkbox/radio).

## States
default / filled / focused / error + helper / disabled / loading (disabled + hint pattern).

## Accessibility
Labels via label/InputLabel; helperText for errors; native input semantics.

## Live-spec mapping
Docs-only. To restyle globally add MuiTextField/MuiCheckbox overrides in \`theme.ts\` → all forms.
`],
["hotkey-badge", `# HotkeyBadge · DictationInstruction (\`hotkey-badge\`)

- Status: **recreated** — HotkeyBadge imports \`getPrettyKeyName\` from \`utils/keyboard.utils\`, which pulls the zustand store + tauri invoke + platform utils (unsafe in a plain browser). Recreation copies the Box styles verbatim; key labels copy the mapping rules.
- Source of truth: \`${D}/components/common/HotkeyBadge.tsx\`, \`${D}/components/common/DictationInstruction.tsx\`, \`${D}/utils/keyboard.utils.ts:168-200\`.
- Used in: DictationInstruction, FeatureReleaseDialog, KeybindingsForm, TutorialForm, ManualStylingLayout; instruction in HomePage + TutorialForm.

## Purpose
kbd-style badge rendering hotkey chords; instruction row pairs the “Press your hotkey to dictate anywhere” prompt with the badge (opens shortcuts dialog).

## Visual tokens
inline-flex, 1px divider border, radius 0.5 (4px), px 1 py 0.25, weight 600, level1 fill; clickable adds pointer + action.hover. Instruction: row Stack spacing 1, centered; body2 secondary prompt + badge (flexShrink 0). Key rules: KeyX→X, Meta→⌘/⊞, Control→⌃/Ctrl, Shift→⇧/Shift, Alt→⌥/Alt, Function→Fn, arrows→←→↑↓ (platform from navigator in preview; app uses getPlatform()).

## Motion
None (hover fill only on clickable).

## States
default / clickable hover / empty instruction (renders null when no combo).

## Accessibility
Badge is a static label (no role in source); clickable badge is a div with onClick — UNKNOWN whether keyboard activation exists in production (no tabIndex/role in source; flag as a11y gap).

## Live-spec mapping
Badge radius live (recreated). Weight/spacing patch-only: edit \`HotkeyBadge.tsx\` → all listed call sites.
`],
["hotkey-recorder", `# HotKey recorder field (\`hotkey-recorder\`)

- Status: **recreated** — store-bound (keysHeld, hotkeyStrategy, isRecordingHotkey, setSnackbar). Recreation copies geometry/styles/keyframes verbatim; a local key-capture shim stands in for the store.
- Source of truth: \`${D}/components/common/HotKey.tsx\`.
- Used in: DictationLanguageDialog, HotkeySetting, StyleHotkeysDialog.

## Purpose
Click-to-record hotkey chord field.

## Visual tokens
200×40, centered, radius 1 (8px), pointer; level1 → level2 on focus; 2px transparent border → 2px solid pulsing on focus; hover shows 2px divider border when unfocused; body2 label (secondary when empty: “Recording keys…” / “Set hotkey”; primary when valued).

## Motion
pulseBorder keyframes (blue 50% ↔ blue) 2s ease-in-out infinite while focused. No spring.

## States
empty / valued / recording (focused) / hover / blur-commit; Escape cancels; bridge strategy rejects modifier-only combos with an error snackbar (store path — not simulated).

## Accessibility
tabIndex 0 div with click-to-focus; outline none (pulse replaces it). UNKNOWN: no aria-label/role in source (flag as a11y gap); preview adds both.

## Live-spec mapping
Width live (recreated). Pulse + commit logic patch-only: edit \`HotKey.tsx\` → the three settings dialogs.
`],
["dialog", `# Dialog · DialogTitleWithClose (\`dialog\`)

- Status: **reused** — real MUI Dialog theme + real \`DialogTitleWithClose\`.
- Source of truth: \`${D}/theme.ts\` (MuiDialog, MuiDialogActions), \`${D}/components/common/DialogTitleWithClose.tsx\`.
- Used in: every MUI Dialog; title-with-close in AIAgentModeDialog, AIPostProcessingDialog (+ siblings).

## Purpose
Modal surface with optional close affordance in the title row.

## Visual tokens
Paper: level1, no image, radius 18, hairline, premiumSurface.hover. Actions: padding 24/16/16. TitleWithClose: flex row, gap 1, small IconButton ml auto, aria “Close”, CloseIcon small.

## Motion
MUI dialog enter/exit (theme durations entering 250 / leaving 180).

## States
open / closed / backdrop-click + Esc (MUI) / focus trap / dividers content.

## Accessibility
MUI modal semantics: focus trap, Esc, aria-labelledby via DialogTitle, labelled close button.

## Live-spec mapping
Dialog radius live (MuiDialog paper slot → every dialog).
`],
["confirm-dialog", `# ConfirmDialog (\`confirm-dialog\`)

- Status: **reused** — real component from \`${D}/components/common/ConfirmDialog.tsx\`.
- Source of truth: \`${D}/components/common/ConfirmDialog.tsx\`.
- Used in: SignInForm, SettingsPage, ManualStylingRow, ToneEditorDialog.

## Purpose
Two-action confirmation (Cancel text + Confirm contained).

## Visual tokens
maxWidth xs fullWidth · DialogContent dividers · actions px 3 pb 2 · labels default “Cancel”/“Confirm” (localized), overridable with button props.

## Motion
MUI dialog enter/exit.

## States
open / closed; custom labels; confirmButtonProps/cancelButtonProps passthrough.

## Accessibility
Inherits dialog semantics; actions are real buttons with localized labels.

## Live-spec mapping
Patch-only. Persist: edit \`ConfirmDialog.tsx\` → four call sites. Radii follow the dialog + button specs (live).
`],
["popover-menu", `# MenuPopover · MenuPopoverBuilder (\`popover-menu\`)

- Status: **reused** — real components from \`${D}/components/common/MenuPopover.tsx\` + MuiPopover theme.
- Source of truth: \`${D}/theme.ts\` (MuiPopover), \`${D}/components/common/MenuPopover.tsx\`.
- Used in: ConversationListItem, ContextMenu, Header, AppStylingRow, ManualAddStyle, ManualStylingRow, TranscriptionToneMenu.

## Purpose
Anchor menu of ListTile rows + dividers + hover submenus + generic builders.

## Visual tokens
Popover paper: level1, radius 14, hairline, premiumSurface.hover. Anchor bottom-center → transform top-center; mousedown stops propagation. Submenu: fixed box at parent rect right, zIndex 1300, paper fill, overflow hidden, shape radius; items role=menuitem.

## Motion
MUI popover enter/exit; submenu opens on mouseenter, closes on mouseleave (hide-timer ref present).

## States
open / closed / submenu open / item activation (closes via injected close).

## Accessibility
role=menuitem wrappers; ListTile rows are buttons. UNKNOWN: arrow-key traversal across submenu tiers is not implemented in source (hover-driven) — flag as a11y gap.

## Live-spec mapping
Popover radius live. Item/menu logic patch-only → seven call sites.
`],
["context-menu", `# ContextMenu · useContextMenu (\`context-menu\`)

- Status: **reused** — real component/hook/provider from \`${D}/components/common/ContextMenu.tsx\`.
- Source of truth: \`${D}/components/common/ContextMenu.tsx\`.
- Used in: ChatMessageBubble, ConversationListItem, DictionaryRow, Root (provider), ManualStylingRow, TranscriptRow.

## Purpose
Right-click menus with viewport clamping, clipboard menu on editables (provider), focus restoration.

## Visual tokens
Constants in source (MENU_OFFSET, PADDING, MENU_MIN_WIDTH, MENU_MAX_HEIGHT, ITEM_HEIGHT — read exact numbers in file). Items: label + optional icon + accelerator; danger = error.main; disabled dimmed. Portal to body at zIndex 1400.

## Motion
Instant open at cursor + offset; no enter animation in source. Closes on click-away, external scroll, blur, Esc.

## States
default / empty list (falls through to native menu) / danger / disabled / divider / autoFocus.

## Accessibility
Menu auto-focuses; arrows/Enter navigate (actionable indices skip dividers); Esc captured + focus restored only when the dismissal keeps focus in-page (click-away/scroll do NOT steal focus back); outgoing focus target prefers the right-clicked element.

## Live-spec mapping
Patch-only (constants + handlers in source). Persist: edit \`ContextMenu.tsx\` → six call sites.
`],
["tooltip", `# Tooltip · Conditional · ToolParams · Bouncy (\`tooltip\`)

- Status: **reused** — real theme + real components.
- Source of truth: \`${D}/theme.ts\` (MuiTooltip), \`ConditionalTooltip.tsx\`, \`ToolParamsTooltip.tsx\`, \`onboarding/BouncyTooltip.tsx\`.
- Used in: global (MuiTooltip); ToolParams in ToolPermissionPrompt; Conditional in PostProcessingDisabledTooltip; Bouncy in TutorialForm.

## Purpose
Hover hints; conditional passthrough; JSON param inspector; onboarding attention bubble.

## Visual tokens
Themed tooltip: 13px/550, radius 10, padding 8/12, premiumSurface.rest. ToolParams: InfoOutlined 16 secondary, cursor help, arrow top, pre-wrapped JSON (reason key stripped), renders null when empty. Bouncy: absolute bottom strip, 8px arrow, primary.main fill + contrast text, px2 py1, radius 8, drop-shadow(0 4px 8px rgba(0,0,0,.2)).

## Motion
MUI tooltip fades. Bouncy: bounce 1s ease-in-out infinite + fadeIn 0.2s ease-out both (bounce dropped under reduced motion); exit fadeOutDown 0.2s forwards; pointer-events only while visible.

## States
hover / placement variants / conditional on-off / empty params null / bouncy show-hide-delay-align.

## Accessibility
MUI tooltips expose via aria on focus/hover. Bouncy is presentational (no role in source).

## Live-spec mapping
Tooltip radius live. Bouncy choreography patch-only → TutorialForm.
`],
["snackbar", `# Snackbar emitter visual (\`snackbar\`)

- Status: **recreated** — \`SnackbarEmitter\` reads snackbar* fields from the zustand store. Recreation copies the MUI Snackbar config verbatim.
- Source of truth: \`${D}/components/root/SnackbarEmitter.tsx\`, \`${D}/utils/app.utils.ts\` (setSnackbar).
- Used in: global — any setSnackbar/showErrorSnackbar call site.

## Purpose
Bottom-center transient messages (info/error/success).

## Visual tokens
key=counter (re-mount per message) · #fff message span · small close IconButton (#fff icon, aria “close”) · content style backgroundColor = error/success/primary by mode · anchor bottom-center.

## Motion
MUI snackbar transition (transitionDuration passthrough); auto-hide 3000ms default; clickaway ignored.

## States
info / error / success / dismissed / queued (counter remount).

## Accessibility
Close is labelled; message is plain text. UNKNOWN: no explicit aria-live/role in source — MUI Snackbar defaults apply (verify).

## Live-spec mapping
Docs-only recreation. Persist: edit \`SnackbarEmitter.tsx\` / \`app.utils.ts\` → global.
`],
["feedback", `# Progress · loading · empty states (\`feedback\`)

- Status: **reused** — real \`AppCircularProgress\`, \`CenterLoading\`, \`CenterMessage\`.
- Source of truth: \`${D}/components/common/AppCircularProgress.tsx\`, \`CenterLoading.tsx\`, \`CenterMessage.tsx\`.
- Used in: no call sites found under components/ for any of the three — reserved primitives (verify before deleting).

## Purpose
Determinate/indeterminate progress; full-area loading; titled empty states with optional action.

## Visual tokens
AppCircularProgress: size/value passthrough, determinate iff value set. CenterLoading: full-height centered stack, spacing 2, pb 8. CenterMessage: flex-1 minHeight 100% centered, px 2 py 8, Container xs, stack spacing 2.

## Motion
MUI spinner animation; no custom motion.

## States
indeterminate / determinate value / loading / title-only / title+subtitle+action.

## Accessibility
Empty states are text + real action buttons. UNKNOWN: no role=status/busy wiring in source (verify).

## Live-spec mapping
Patch-only (layout in components). No known call sites.
`],
["card-paper", `# Card · Paper (\`card-paper\`)

- Status: **reused** — real MUI theme (MuiCard/MuiPaper).
- Source of truth: \`${D}/theme.ts\` (MuiCard, MuiPaper).
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
Card radius live. Hover/ ramp patch-only (\`theme.ts\` MuiCard/MuiPaper → global).
`],
["list-tile", `# ListTile (\`list-tile\`)

- Status: **reused** — real component + MuiListItemButton/MuiListItemText theme.
- Source of truth: \`${D}/theme.ts\` (MuiListItemButton, MuiListItemText), \`${D}/components/common/ListTile.tsx\`, \`OverflowTypography.tsx\`.
- Used in: MenuPopover, DashboardMenu, UpdateListTile, SettingsPage, AppStylingRow, ManualStylingRow.

## Purpose
Universal row: leading/trailing with hover swap, title/subtitle, selected state, href/cmd-click, motion indicator slot.

## Visual tokens
Button: radius 14, mb 4, minHeight 44, py 10; hover ink/highlight .04; selected light = ink fill + level1 text (primary 650) + secondary highlight .72 + selected shadow; dark = level2 + selected shadow. Primary text 550/.9375rem/−.01em. HoverButton swaps idle→icon-button (my −1, mx −1.5) on row hover; clicks stop propagation.

## Motion
bg 100ms (shortest) + transform 90ms var(--ease-out-cubic); active scale(0.975) — explicitly no will-change (tested jank-free on Apple Silicon/Intel/Win11/Linux iGPU). Reduced motion: transition none, no press scale.

## States
default / hover (swap) / selected / disabled / href (+cmd-click new tab) / leading/trailing actions / indicator slot.

## Accessibility
Real ListItemButton (button semantics, keyboard, focus-visible ring); OverflowTypography tooltips truncated titles.

## Live-spec mapping
Row radius live. Press/swap choreography patch-only: \`ListTile.tsx\` + \`theme.ts\` → six call sites.
`],
["table", `# AppTable (\`table\`)

- Status: **reused** — real component from \`${D}/components/common/AppTable.tsx\`.
- Source of truth: \`${D}/components/common/AppTable.tsx\`.
- Used in: no call sites found under components/ — reserved primitive (verify before deleting).

## Purpose
Virtualized sortable table (react-virtuoso) in Paper.

## Visual tokens
Div-based MUI table, separate borders, fixed layout; weight/fixed column widths; head cells level1, pointer + TableSortLabel when sortable.

## Motion
None (instant sort).

## States
unsorted / asc / desc / empty / footer / custom row component.

## Accessibility
Headers are clickable cells with sort labels; UNKNOWN: aria-sort wiring (MUI TableSortLabel handles direction; verify table roles in div mode).

## Live-spec mapping
Patch-only. No known call sites.
`],
["accordion", `# Accordion (\`accordion\`)

- Status: **reused** — real MUI theme (MuiAccordion*).
- Source of truth: \`${D}/theme.ts\` (MuiAccordion, Summary, Details).
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
`],
["stepper", `# AppStepper (\`stepper\`)

- Status: **reused** — real component from \`${D}/components/common/AppStepper.tsx\`.
- Source of truth: \`${D}/components/common/AppStepper.tsx\`.
- Used in: no call sites found under components/ — reserved primitive (verify before deleting).

## Purpose
Vertical wizard stepper with active pill.

## Visual tokens
Active StepLabel: radius 64 pill, primary.main, px 1.5 py 0.5, label 18/600 contrast, icon 22 contrast scale 1.1; base label 16, icons 20; completed show Check; non-clickable opacity .5.

## Motion
bg/padding/font-size/color/transform 180ms short; clickable hover scale 1.05 + pointer.

## States
pending / active / completed / clickable / locked (readyIndex) / disabled opacity.

## Accessibility
Clickable steps are onClick labels — UNKNOWN: no button role/tabindex in source (flag as a11y gap).

## Live-spec mapping
Patch-only. No known call sites.
`],
["breadcrumb", `# Breadcrumb (\`breadcrumb\`)

- Status: **reused** — real component from \`${D}/components/common/Breadcrumb.tsx\`.
- Source of truth: \`${D}/components/common/Breadcrumb.tsx\`.
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
`],
["typography-helpers", `# Overflow · Edit · WithMore · CopyableCommand (\`typography-helpers\`)

- Status: **reused** — real components.
- Source of truth: \`OverflowTypography.tsx\`, \`EditTypography.tsx\`, \`TypographyWithMore.tsx\`, \`CopyableCommand.tsx\`.
- Used in: ChatMessageBubble + ListTile (Overflow); TranscriptRow (WithMore); EditTypography + CopyableCommand have no call sites found (reserved).

## Purpose
Ellipsis-with-conditional-tooltip; click-to-edit text/number; clamped prose with More/Less; copyable code block.

## Visual tokens
CopyableCommand: row stack spacing 1, centered, p 1.5, radius 8, action.hover fill; code monospace .8rem break-all lh 1.5; icon 16 (check success.main after copy). WithMore: -webkit-box clamp, localized More/Less button.

## Motion
CopyableCommand icon swap 0.2s ease (transform+opacity); copied check reverts after 2000ms.

## States
fits/overflows · display/edit/commit/cancel/invalid · clamped/expanded · copied/idle.

## Accessibility
EditTypography commits on Enter, cancels on Esc (verify labels at call sites); copy button is a real IconButton (add aria-label at call site — verify).

## Live-spec mapping
Patch-only per component → listed call sites.
`],
["waveform", `# AudioWaveform (\`waveform\`)

- Status: **reused** — real component from \`${D}/components/common/AudioWaveform.tsx\`.
- Source of truth: \`${D}/components/common/AudioWaveform.tsx\`.
- Used in: MicrophoneTester, MicCheckForm. The native pill ports this physics (rust_macos_pill constants “ported from AudioWaveform.tsx”).

## Purpose
Live SVG level waves for mic input.

## Visual tokens
120×36 default (props), stroke 1.6, 3 waves (freq .8/1.0/1.25, mult 1.6/1.35/1.05, offsets 0/.85/1.7, opacity 1/.78/.56), ≥72 segments, round joins.

## Motion
rAF loop: smoothing 0.18 toward target, decay 0.985/frame, phase step 0.11 + gain 0.32×level, amplitude clamp .03–1.3, processing base level 0.16.

## States
active/live · idle · processing shimmer · custom stroke/size/baseline.

## Accessibility
Presentational canvas (verify aria-hidden at call sites).

## Live-spec mapping
Patch-only (physics in component). Persist → mic tester + mic check form. Pill must be re-ported by hand if physics changes.
`],
["logo", `# Logo · LogoWithText (\`logo\`)

- Status: **reused** — real components + real PNG assets.
- Source of truth: \`${D}/components/common/Logo.tsx\`, \`LogoWithText.tsx\`, \`${D}/assets/app-logo-*.png\`.
- Used in: TitleBar, login/welcome surfaces.

## Purpose
Product mark + wordmark lockup.

## Visual tokens
PNG mark at 32/64/192; wordmark in TAN-PARADISO (display face sanctioned here).

## Motion
None.

## States
mark / lockup.

## Accessibility
Decorative adjacent to text (verify alt/aria-hidden at call sites).

## Live-spec mapping
Patch-only (assets + lockup component).
`],
["dashboard-menu", `# DashboardMenu sidebar rail (\`dashboard-menu\`)

- Status: **recreated shell** — the real menu reads the store (assistant-mode flag, update availability) + app router. Recreation copies rail wash/geometry/indicator verbatim and renders REAL ListTile + MorphNavIcon rows.
- Source of truth: \`${D}/components/dashboard/DashboardMenu.tsx\`, \`UpdateListTile.tsx\`.
- Used in: DashboardPage, AppSideEffects.

## Purpose
Left rail navigation with a gliding active indicator.

## Visual tokens
Rail: radius 16, margin 0.35rem, hairline .05, 180deg wash (light level1 .7→level0 .35; dark level2 .55→level0 .2). List px 1.5 pb 2 pt 0.5; rows mb 0.5; selected ListItemButton forced transparent (indicator paints the fill). Indicator: absolute inset 0, radius 14, ink fill light / level2 dark, selected shadow.

## Motion
Shared-layout indicator (\`layoutId="sidebar-active"\`) with \`springSnappy\`; static box under reduced motion. Row press from ListTile.

## States
per-route selected / settings pinned bottom / update tile conditional / hover / reduced motion.

## Accessibility
Rows are ListTile buttons; indicator is pointer-events none (decorative).

## Live-spec mapping
Indicator radius live (recreated). Rail wash patch-only: edit \`DashboardMenu.tsx\` → DashboardPage.
`],
["morph-icon", `# MorphNavIcon (\`morph-icon\`)

- Status: **reused** — real component from \`${D}/components/common/MorphNavIcon.tsx\`.
- Source of truth: \`${D}/components/common/MorphNavIcon.tsx\`.
- Used in: DashboardMenu, TitleBar.

## Purpose
State-swapping glyphs that morph instead of cutting.

## Visual tokens
inline-flex box size×size, svg block; MorphIcon size 22, currentColor, strokeWidth 1.85, spring “snappy”.

## Motion
morphicons snappy spring between icon nodes (e.g. Square↔Copy for maximize/restore).

## States
per-icon nodes / sizes / colors.

## Accessibility
Decorative inside labelled buttons (verify aria at call sites).

## Live-spec mapping
Patch-only → DashboardMenu + TitleBar.
`],
["layout", `# PageLayout · SplitLayout · Section · SettingSection · FadingScrollArea · ScrollListPage (\`layout\`)

- Status: **reused** — all real components.
- Source of truth: \`PageLayout.tsx\`, \`SplitLayout.tsx\`, \`Section.tsx\`, \`SettingSection.tsx\`, \`FadingScrollArea.tsx\`, \`ScrollListPage.tsx\` (+ \`scrollListCollapse.ts\`).
- Used in: Apps/Dictionary/Styling/Transcriptions pages (ScrollList); ConversationLayout/ListLayout (Fading); settings dialogs (Section/SettingSection); AppWrapper + ErrorBoundary (PageLayout).

## Purpose
App shell (TitleBar + header + scroll content), weighted panes, settings rows/groups, fading scroller, infinite list template.

## Visual tokens
PageLayout: full-bleed stack level0, header px .5/1 pt .5, content scroll. SplitLayout: weight-fraction columns, zero-weight unmounts (sticky once shown). SettingSection: row spacing 2 center/space-between; title body1/600, desc body2 secondary. Section: h6 bold + optional checkbox (ml 1 pt 1), desc body2 mt 1, children mt 2, mb 4; blocked → 30% opacity + not-allowed tooltip veil overlay. ScrollListPage: header/content maxWidth sm, emptyState, hasMore/onLoadMore.

## Motion
None custom (native scroll; collapse helper animates list collapse — see scrollListCollapse.ts).

## States
header/footer slots · weights · enabled toggle on/off · blocked + reason · fade edges · items/empty/loading-more.

## Accessibility
Section toggle is a clickable Box — UNKNOWN: no checkbox role/keyboard in source (flag as gap; SettingSection actions are caller-provided). ScrollListPage title/action are text + caller nodes.

## Live-spec mapping
Patch-only per component → listed pages/dialogs.
`],
["titlebar", `# TitleBar · ThemeModeToggle · WindowResizeHandles (\`titlebar\`)

- Status: **reused** — real components; Tauri calls gated by \`isTauriRuntime()\` so controls safely no-op in a plain browser.
- Source of truth: \`root/TitleBar.tsx\`, \`ThemeModeToggle.tsx\`, \`WindowResizeHandles.tsx\`, \`utils/env.utils.ts\`, \`src-tauri/capabilities/default.json\`.
- Used in: PageLayout (→ AppWrapper).

## Purpose
Frameless custom chrome: drag region + theme toggle + logo + window controls; invisible resize grips (decorations:false removes the OS border).

## Visual tokens
Bar 40px (DESIGN.md says ~46 — code is 40), level1 @ .88/.92 + blur(18px) saturate(1.2) + titleBarShadow, bottom hairline .06/.05, zIndex 20. Controls 16px glyphs in 28px buttons; theme toggle 28×28 radius 12 secondary, menu items 16px icons + check. Drag region full-bleed + double-click toggles maximize.

## Motion
Toggle transitions 150ms easeOut (bg/color/transform); maximize glyph morphs Square↔Copy via MorphNavIcon; no bounce.

## States
light/dark/system · maximized/unmaximized icon · hover/press on controls · drag/double-click (Tauri only) · resize grips (Tauri only).

## Accessibility
Controls are IconButtons with localized labels (verify aria-labels in source); theme menu is a real MUI Menu with checks.

## Live-spec mapping
Docs-only (chrome geometry + Tauri wiring). Persist: edit \`TitleBar.tsx\` (+ capabilities JSON for new window commands) → PageLayout. NOTE: every window command must be listed in \`src-tauri/capabilities/default.json\` or controls fail silently.
`],
["native-pill", `# Native overlay pill — dictation (\`native-pill\`)

- Status: **recreated** — painted by a separate native process (rust_macos_pill, Cairo) outside the webview; direct reuse impossible. Canvas recreation from exact constants.
- Source of truth: \`packages/rust_macos_pill/src/constants.rs\`, \`draw.rs\`, \`state.rs\`, \`gfx.rs\`, \`packages/rust_pill_shared/src/lib.rs\`, \`${D}/components/root/OverlaySyncSideEffects.ts\` (payload).
- Used in: native overlay window. Phases idle/recording/loading/paused; sizes dictation/assistant_compact/expanded/typing. Placement configured by PillPlacementSetting.

## Purpose
Always-on-top state surface: movement/size conveys state, not choreography.

## Visual tokens
Window 200×86 · pill area 48 · min 48×6 → expanded 120×32 · radius = min(w,h)/2 capped 16 (true capsule; cap scales with drag inflate) · bg black lerp(.6→.92, expand_t) · border white .3 inset .5px 1px. Waveform: 3 white waves (freq .8/1/1.25, mult 1.6/1.35/1.05, offsets 0/.85/1.7, opacity 1/.78/.56), stroke 1.6 round, amplitude pill_h×.75×clamp(level×mult,.03,1.3), pad pill_h×.1, alpha ×expand_t. Loading: 2px track white .15, indicator 40% white .7 (MUI-linear-progress port). Paused: centered 40% bar white .45 on track white .1. Idle hover: Satoshi 12 white “Click to dictate” (drag label “Drag To Move”). Edge gradients black .9×expand_t (left 18%, right 15%). Tooltip 172×32 r12 gap 6; flash 32 r12 gap 6 dur 2.5s; transcript 28 r10 font 12 fade 3s+6/s rise 12; long-press ring (0.92,0.95,1.0) 0.45s hold 0.12s delay; drag inflate ×1.18 (stiffness 280); cancel button 18.

## Motion
Expand spring stiffness 200. Wave phase 0.11 + 0.32×level/frame; level smoothing 0.18, decay 0.985/frame; loading 0.015/frame. UNKNOWN: expand damping ratio (not in constants) — recreation uses critical damping per “no spring-bounce on tools”; confirm against the native feel before changing.

## States
idle collapsed / idle hover label / recording wave / loading bar / paused bar / tooltip / flash / transcript / long-press ring / drag inflate.

## Accessibility
UNKNOWN: native surface — no ARIA/keyboard contract visible from the webview (verify with platform owners).

## Live-spec mapping
Expanded w/h, radius cap, active bg alpha live (recreated). Everything else patch-only: edit Rust constants + rebuild the pill process; payload shape in OverlaySyncSideEffects.
`],
["assistant-panel", `# Assistant panel — compact · expanded · typing (\`assistant-panel\`)

- Status: **recreated** — same native process as the pill; DOM recreation from exact PANEL_* constants.
- Source of truth: \`packages/rust_macos_pill/src/constants.rs\` (PANEL_*), \`draw.rs\` panel section.
- Used in: native overlay window (assistant_compact/expanded/typing).

## Purpose
Assistant transcript/permission/review surface above the pill.

## Visual tokens
compact 424 (window 452×144) · expanded 572 (600×282) · typing 572 high (600×362) · radius 24 · bg black .96 · border white .12 · margins top 14 bottom 10 · header 10/10 right 24, buttons 28 · content inset 24 · transcript top 56 · input 48 · perm card 68, buttons 80×26 gap 6 (first +16), fill white .08 border white .15 label 11 · cards fill white .06 border white .12 · review eyebrow Satoshi 11 italic white .5, text 14 white .92, hint 11 white .45, actions row 44.

## Motion
Panel open/close + scroll fades per draw.rs (UNKNOWN exact curves — not extracted; verify in state.rs/draw.rs before animating).

## States
compact/expanded/typing × transcript/permission/review; scroll pads 12/12; keyboard button 32 gap 8.

## Accessibility
UNKNOWN: native surface contract (verify).

## Live-spec mapping
Radius + bg alpha live (recreated). Geometry patch-only: edit Rust + rebuild.
`],
["audio-player-pill", `# AudioPlayerPill (\`audio-player-pill\`)

- Status: **recreated** — loads bytes from the transcription repo + WebAudio (repos/actions chain). Recreation copies layout/styles/bar math; playback is a simulated clock.
- Source of truth: \`${D}/components/transcriptions/AudioPlayerPill.tsx\`, \`${D}/utils/audio-playback.utils.ts\`.
- Used in: \`${D}/components/transcriptions/TranscriptRow.tsx\`.

## Purpose
Inline recording playback with waveform + progress veil.

## Visual tokens
Flex row, radius 999, 1px divider border, level1, px 1 py .25, gap 1, maxWidth 350. Play/pause IconButton small p .5, localized labels. Duration body2 secondary tnum minWidth 42. Waveform h 22 flex 1: bars width clamp 2–4 gap 2 count 24–120 (default 58 when unmeasured), radius spacing .25, primary.main, height 35+value×55%; veil level1 @.5 from progress% with left 140ms linear.

## Motion
Veil left 140ms linear; bar opacity 140ms ease. ResizeObserver recomputes count/width.

## States
idle / playing / paused / ended (reset) / disabled / null duration (“0:00”) / error → error snackbar (store path, not simulated).

## Accessibility
Play/pause has localized aria-labels; progress is visual-only (verify live-region needs).

## Live-spec mapping
Max width live (recreated). Bar math patch-only: edit \`AudioPlayerPill.tsx\` / \`audio-playback.utils.ts\` → TranscriptRow. NOTE: bar outline here is a seeded PRNG keyed by id; production derives it from content (buildWaveformOutline).
`],
["tool-permission", `# ToolPermissionPrompt · ToolPermissionCard (\`tool-permission\`)

- Status: **recreated** — store-bound (toolInfoById) + actions (resolveToolPermission/setToolAlwaysAllow). Recreation copies both variants’ sx verbatim; real ToolParamsTooltip inside.
- Source of truth: \`${D}/components/common/ToolPermissionPrompt.tsx\`, \`${D}/components/chats/ToolPermissionCard.tsx\`.
- Used in: ToolPermissionCard (chat tool queue).

## Purpose
Allow/deny/always-allow prompt for assistant tool calls, inline in chat or overlaid.

## Visual tokens
Default: row stack, card maxWidth 75% px 2 py 1.5 radius 8, 1px primary.main border, paper fill; title body2/600 + params tooltip + status chip (success/error) when resolved; reason caption secondary; pending chips: Deny outlined, Allow primary, Always-allow outlined borderless. Overlay: px 1.5 py 1 radius 8, white .2 border, white .06 fill; title 13/600 white .92 + 14px tooltip; reason 12 white .5; right-aligned buttons mt .75 firing on mouse-down: Deny (bordered), Allow (white-filled black text), Always allow (ghost); OverlayButton 12/500 px1 py.25, hover white .08 (ghost) / .85 (filled).

## Motion
None (instant mount; hover fills only).

## States
pending / allowed / denied × default / overlay; reason present/absent.

## Accessibility
Real Chips/buttons with localized labels; overlay buttons are \`<button>\` with mouse-down activation (keyboard path: verify focus/Enter behavior).

## Live-spec mapping
Docs-only recreation. Persist: edit \`ToolPermissionPrompt.tsx\` → ToolPermissionCard.
`],
["tone-select", `# ToneSelect · TranscriptionToneMenu (\`tone-select\`)

- Status: **recreated slice** — store/action-bound (tone CRUD, prefs). Recreation copies the render code; fixture tones; menus compose the REAL MenuPopoverBuilder + ListTile.
- Source of truth: \`${D}/components/tones/ToneSelect.tsx\`, \`${D}/components/transcriptions/TranscriptionToneMenu.tsx\`.
- Used in: AppStylingLayout, AppStylingRow, TranscriptionToneMenu.

## Purpose
Style picker (select + row-menu variants) with create/edit affordances.

## Visual tokens
FormControl + displayEmpty Select; “New style” row (Add small); tone rows: name + global Public tooltip (“cannot be edited”) or Edit IconButton (stops propagation, closes menu, opens editor dialog); system tones show neither; empty value renders “Default” / “Default ({toneName})”.

## Motion
MUI select/menu motion; sorted ids via getSortedToneIds.

## States
empty default / selected / disabled / global/system/custom rows / menu open-closed.

## Accessibility
MUI select semantics + labels; per-row edit buttons stop propagation (verify focus return after dialog).

## Live-spec mapping
Docs-only slice. Radii/motion follow popover-menu + list-tile + text-field specs (live there). Persist: edit \`ToneSelect.tsx\` → styling + transcription call sites.
`],
["mic-check", `# MicrophoneSelector · MicrophoneTester (\`mic-check\`)

- Status: **recreated slice** — native device enumeration via @maus-inc/desktop-native-apis (tauri invoke) is unavailable in a browser. Recreation copies render code; fixtures; REAL AudioWaveform in the tester.
- Source of truth: \`${D}/components/microphone/MicrophoneSelector.tsx\`, \`MicrophoneTester.tsx\`.
- Used in: MicCheckForm, MicrophoneDialog.

## Purpose
Device picker + live input test.

## Visual tokens
Stack spacing 1.5; fullWidth small FormControl + “Microphone” label; Automatic row + Recommended filled chip; divider my .5; device rows: label + unavailable (warning caption) / caution (secondary caption) + Default (primary outlined) / Caution (warning outlined) chips; Refresh text button + 18px spinner; error Alert.

## Motion
MUI select/menu; spinner while enumerating.

## States
default / loading / error / disabled / unavailable + caution devices / tester waveform live.

## Accessibility
Labelled select; status captions are text (verify live-region for enumeration state).

## Live-spec mapping
Docs-only slice. Persist: edit \`MicrophoneSelector.tsx\` → MicCheckForm + MicrophoneDialog. Waveform physics: see waveform spec.
`],
];

for (const [id, md] of SPECS) {
  writeFileSync(join(root, `${id}.md`), `${md}\n`);
}
console.log(`wrote ${SPECS.length} spec files to ${root}`);
