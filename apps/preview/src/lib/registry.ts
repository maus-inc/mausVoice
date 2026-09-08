/**
 * Component registry — the single index of everything the preview site covers.
 *
 * `status: "reused"`  → the demo renders the REAL component imported from
 *                        apps/desktop/src (via the @desktop alias).
 * `status: "recreated"` → direct reuse was impossible (store/firebase/tauri/
 *                        native-surface dependency); the demo renders a
 *                        pixel-spec recreation from src/recreated/* built from
 *                        exact values in theme.ts / palette.ts / shadows.ts /
 *                        motion.ts / rust_macos_pill constants. `statusNote`
 *                        states the precise reason per component.
 *
 * `usedIn` paths come from a name-grep over apps/desktop/src/components
 * (self-file excluded). "No call sites found" means the grep was empty —
 * those components are either legacy, used outside components/, or wired
 * through a path the grep cannot see; each spec file says so explicitly.
 */

export type CategoryId =
  | "foundations"
  | "buttons"
  | "forms"
  | "dialogs"
  | "data"
  | "navigation"
  | "layout"
  | "chrome"
  | "pill";

export const CATEGORIES: { id: CategoryId; label: string; blurb: string }[] = [
  { id: "foundations", label: "Foundations", blurb: "Color ladder, type scale, elevation, motion tokens — rendered from the real token modules." },
  { id: "buttons", label: "Buttons", blurb: "CTA variants, icon buttons, FABs." },
  { id: "forms", label: "Forms", blurb: "Switches, sliders, segmented controls, inputs, hotkey surfaces." },
  { id: "dialogs", label: "Dialogs & feedback", blurb: "Dialogs, popovers, menus, tooltips, snackbars, loading and empty states." },
  { id: "data", label: "Data display", blurb: "Cards, rows, tables, steppers, waveform, logo." },
  { id: "navigation", label: "Navigation", blurb: "Sidebar rail, morphing icons, breadcrumbs." },
  { id: "layout", label: "Layout", blurb: "Page shells, sections, scrolling list templates." },
  { id: "chrome", label: "Window chrome", blurb: "Frameless title bar, theme toggle, resize grips." },
  { id: "pill", label: "Pill-adjacent & app-bound", blurb: "Native overlay pill, assistant panel, and store-bound slices recreated from exact specs." },
];

export type SpecTarget =
  /** Live: overrides the MUI CSS variable (scheme-scoped) everywhere. */
  | { kind: "palette"; scheme: "light" | "dark" | "both"; token: string }
  /** Live: merged into the component's styleOverrides slot in a derived theme. */
  | { kind: "component"; component: string; slot?: string; nested?: string; cssProp: string }
  /** Live: patched theme.transitions.duration[token]. */
  | { kind: "duration"; token: string }
  /** Live: patched theme.transitions.easing[token]. */
  | { kind: "easing"; token: string }
  /** Live: patched theme.shape.borderRadius. */
  | { kind: "shape" }
  /** Live: consumed by recreated components via useSpecValue(). */
  | { kind: "recreated"; key: string }
  /** Patch-only: hardcoded at the call site; editor shows the exact patch. */
  | { kind: "source"; file: string; line?: string };

export type SpecFieldType =
  | "color"
  | "radius"
  | "duration"
  | "easing"
  | "opacity"
  | "number"
  | "select"
  | "text";

export type SpecField = {
  key: string;
  label: string;
  type: SpecFieldType;
  /** Spec default — always the value currently in the real app source. */
  default: number | string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  target: SpecTarget;
  /** Human-readable mapping back to the real app source. */
  mapsTo: string;
  /** Copyable patch snippet (shown when the field is patch-only, or as the
   *  persist-this-change reference for live fields). */
  patch?: string;
  help?: string;
};

export type RegistryEntry = {
  id: string;
  name: string;
  category: CategoryId;
  status: "reused" | "recreated";
  statusNote?: string;
  /** Real-app source files (design truth). */
  sources: string[];
  /** Real-app files that render this component. */
  usedIn: string[];
  /** Demo key resolved in src/demos/index.tsx. */
  demo: string;
  spec: SpecField[];
};

const D = "apps/desktop/src/";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_OUT_CUBIC = "cubic-bezier(0.33, 1, 0.68, 1)";
const EASE_IN_OUT = "cubic-bezier(0.645, 0.045, 0.355, 1)";

export const EASING_OPTIONS = [
  { value: EASE_OUT, label: "easeOut · quint (0.23, 1, 0.32, 1)" },
  { value: EASE_OUT_CUBIC, label: "sharp · cubic (0.33, 1, 0.68, 1)" },
  { value: EASE_IN_OUT, label: "easeInOut (0.645, 0.045, 0.355, 1)" },
];

const durationField = (
  key: string,
  label: string,
  token: string,
  def: number,
): SpecField => ({
  key,
  label,
  type: "duration",
  default: def,
  min: 0,
  max: 600,
  step: 10,
  unit: "ms",
  target: { kind: "duration", token },
  mapsTo: `${D}theme.ts → transitions.duration.${token} (live everywhere via derived theme)`,
  patch: `// ${D}theme.ts → transitions.duration\n${token}: ${def},`,
});

const radiusField = (
  key: string,
  label: string,
  component: string,
  def: number,
  slot?: string,
  nested?: string,
): SpecField => ({
  key,
  label,
  type: "radius",
  default: def,
  min: 0,
  max: 28,
  step: 1,
  unit: "px",
  target: { kind: "component", component, slot, nested, cssProp: "borderRadius" },
  mapsTo: `${D}theme.ts → ${component}.styleOverrides.${slot ?? "root"}.borderRadius (live everywhere via derived theme)`,
  patch: `// ${D}theme.ts → ${component}\nborderRadius: ${def},`,
});

export const REGISTRY: RegistryEntry[] = [
  // ─── Foundations ────────────────────────────────────────────────
  {
    id: "color",
    name: "Color · surface ladder & accents",
    category: "foundations",
    status: "reused",
    sources: [`${D}styles/palette.ts`, `${D}theme.ts (colorSchemes)`],
    usedIn: ["Every themed surface (palette is global)."],
    demo: "color",
    spec: [
      { key: "level0-light", label: "Level 0 · light (canvas)", type: "color", default: "#F5F2ED", target: { kind: "palette", scheme: "light", token: "level0" }, mapsTo: `${D}styles/palette.ts → surfaces.light.level0` },
      { key: "level1-light", label: "Level 1 · light (surface)", type: "color", default: "#FDFBF8", target: { kind: "palette", scheme: "light", token: "level1" }, mapsTo: `${D}styles/palette.ts → surfaces.light.level1` },
      { key: "level2-light", label: "Level 2 · light (raised)", type: "color", default: "#ECE8E1", target: { kind: "palette", scheme: "light", token: "level2" }, mapsTo: `${D}styles/palette.ts → surfaces.light.level2` },
      { key: "level3-light", label: "Level 3 · light (elevated)", type: "color", default: "#E0DBD2", target: { kind: "palette", scheme: "light", token: "level3" }, mapsTo: `${D}styles/palette.ts → surfaces.light.level3` },
      { key: "level0-dark", label: "Level 0 · dark (canvas)", type: "color", default: "#0C0C0D", target: { kind: "palette", scheme: "dark", token: "level0" }, mapsTo: `${D}styles/palette.ts → surfaces.dark.level0` },
      { key: "level1-dark", label: "Level 1 · dark (surface)", type: "color", default: "#161617", target: { kind: "palette", scheme: "dark", token: "level1" }, mapsTo: `${D}styles/palette.ts → surfaces.dark.level1` },
      { key: "level2-dark", label: "Level 2 · dark (raised)", type: "color", default: "#1F1F21", target: { kind: "palette", scheme: "dark", token: "level2" }, mapsTo: `${D}styles/palette.ts → surfaces.dark.level2` },
      { key: "level3-dark", label: "Level 3 · dark (elevated)", type: "color", default: "#2A2A2C", target: { kind: "palette", scheme: "dark", token: "level3" }, mapsTo: `${D}styles/palette.ts → surfaces.dark.level3` },
      { key: "blue-light", label: "Accent blue · light", type: "color", default: "#1b8af8", target: { kind: "palette", scheme: "light", token: "blue" }, mapsTo: `${D}styles/palette.ts → accent.light.main (#1b8af8ff)` },
      { key: "blue-dark", label: "Accent blue · dark", type: "color", default: "#3198ff", target: { kind: "palette", scheme: "dark", token: "blue" }, mapsTo: `${D}styles/palette.ts → accent.dark.main (#3198ffff)` },
      { key: "blue-hover-light", label: "Blue hover · light", type: "color", default: "#1a7cd4", target: { kind: "palette", scheme: "light", token: "blueHover" }, mapsTo: `${D}theme.ts → light.palette.blueHover (#1a7cd4ff)` },
      { key: "blue-hover-dark", label: "Blue hover · dark", type: "color", default: "#2787e6", target: { kind: "palette", scheme: "dark", token: "blueHover" }, mapsTo: `${D}theme.ts → dark.palette.blueHover (#2787e6ff)` },
      { key: "blue-active-light", label: "Blue active · light", type: "color", default: "#166bbf", target: { kind: "palette", scheme: "light", token: "blueActive" }, mapsTo: `${D}theme.ts → light.palette.blueActive` },
      { key: "blue-active-dark", label: "Blue active · dark", type: "color", default: "#1f76cc", target: { kind: "palette", scheme: "dark", token: "blueActive" }, mapsTo: `${D}theme.ts → dark.palette.blueActive` },
    ],
  },
  {
    id: "typography",
    name: "Typography scale",
    category: "foundations",
    status: "reused",
    sources: [`${D}theme.ts (typography)`, `${D}styles/fonts.css`],
    usedIn: ["Every text surface (scale is global). UI face Satoshi; TAN-PARADISO only for logo/welcome."],
    demo: "typography",
    spec: [
      { key: "font-ui", label: "UI family", type: "text", default: '"Satoshi", system-ui', target: { kind: "source", file: `${D}theme.ts`, line: "uiFont" }, mapsTo: `${D}theme.ts → uiFont (+ ${D}styles/fonts.css @font-face)`, patch: `const uiFont = '"Satoshi", system-ui, -apple-system, sans-serif';` },
      { key: "radius-note", label: "Shape radius (global)", type: "radius", default: 14, min: 0, max: 28, step: 1, unit: "px", target: { kind: "shape" }, mapsTo: `${D}theme.ts → shape.borderRadius (live everywhere via derived theme)`, patch: `shape: { borderRadius: 14 },` },
    ],
  },
  {
    id: "elevation",
    name: "Elevation · premiumSurface & hairlines",
    category: "foundations",
    status: "reused",
    sources: [`${D}styles/shadows.ts`, `${D}theme.ts (shadows: none + component boxShadows)`],
    usedIn: ["MuiButton (contained/flat)", "MuiFab", "MuiCard", "MuiPaper flat", "MuiDialog", "MuiPopover", "MuiTooltip", "MuiAccordion", "MuiListItemButton selected", "TitleBar (titleBarShadow)"],
    demo: "elevation",
    spec: [
      { key: "hairline-alpha", label: "Hairline alpha (docs)", type: "opacity", default: 0.06, min: 0, max: 0.2, step: 0.01, target: { kind: "source", file: `${D}styles/shadows.ts`, line: "hairline()" }, mapsTo: `${D}styles/shadows.ts → hairline.light/dark(alpha) — baked into component borders; patch-only`, patch: `hairline.light(0.06) // → 1px solid rgba(26, 23, 18, 0.06)` },
    ],
  },
  {
    id: "motion",
    name: "Motion tokens & transitions",
    category: "foundations",
    status: "reused",
    sources: [`${D}styles/motion.ts`, `${D}theme.ts (transitions)`, `${D}styles/fonts.css (:root vars)`],
    usedIn: ["AnimateIn / AnimateSwitch", "SegmentedControl", "DashboardMenu", "DashboardPage", "TutorialForm", "UnlockedProForm", "ElasticSlider", "ListTile", "AppFab", "AppStepper", "ThemeModeToggle", "HotKey"],
    demo: "motion",
    spec: [
      durationField("shortest", "Shortest", "shortest", 100),
      durationField("shorter", "Shorter", "shorter", 150),
      durationField("short", "Short", "short", 180),
      durationField("standard", "Standard", "standard", 220),
      durationField("entering", "Entering screen", "enteringScreen", 250),
      durationField("leaving", "Leaving screen", "leavingScreen", 180),
      { key: "ease-out", label: "Easing · easeOut", type: "easing", default: EASE_OUT, options: EASING_OPTIONS, target: { kind: "easing", token: "easeOut" }, mapsTo: `${D}theme.ts → transitions.easing.easeOut (live via derived theme)` },
      { key: "ease-sharp", label: "Easing · sharp", type: "easing", default: EASE_OUT_CUBIC, options: EASING_OPTIONS, target: { kind: "easing", token: "sharp" }, mapsTo: `${D}theme.ts → transitions.easing.sharp (live via derived theme)` },
    ],
  },
  {
    id: "animate",
    name: "AnimateIn · AnimateSwitch",
    category: "foundations",
    status: "reused",
    sources: [`${D}components/common/AnimateIn.tsx`, `${D}styles/motion.ts (springSnappy)`],
    usedIn: [`${D}components/settings/AIPostProcessingConfiguration.tsx`, `${D}components/settings/AITranscriptionConfiguration.tsx`],
    demo: "animate",
    spec: [
      { key: "enter-y", label: "Enter Y offset (docs)", type: "number", default: 6, target: { kind: "source", file: `${D}components/common/AnimateIn.tsx` }, mapsTo: `${D}components/common/AnimateIn.tsx → initial { y: 6 } / AnimateSwitch { y: 8 } — patch-only`, patch: `initial={{ opacity: 0, y: 6, scale: 0.99 }} // AnimateIn\ninitial={{ opacity: 0, y: 8, scale: 0.99 }} // AnimateSwitch` },
      { key: "spring", label: "Spring (docs)", type: "text", default: "snappy 420/32/0.8", target: { kind: "source", file: `${D}styles/motion.ts` }, mapsTo: `${D}styles/motion.ts → springSnappy { stiffness 420, damping 32, mass 0.8 } — patch-only`, patch: `export const springSnappy = { type: "spring", stiffness: 420, damping: 32, mass: 0.8 };` },
    ],
  },

  // ─── Buttons ────────────────────────────────────────────────────
  {
    id: "button",
    name: "Button (contained · text · flat · blue)",
    category: "buttons",
    status: "reused",
    sources: [`${D}theme.ts (MuiButton)`],
    usedIn: ["Global — every MUI Button in the app (incl. ConfirmDialog actions, dialogs, forms)."],
    demo: "button",
    spec: [
      radiusField("radius", "Corner radius", "MuiButton", 12),
      { key: "font-size", label: "Font size (docs)", type: "number", default: 15, unit: "px", target: { kind: "source", file: `${D}theme.ts`, line: "MuiButton.root" }, mapsTo: `${D}theme.ts → MuiButton root fontSize 15 (pxToRem), weight 600, padding 8/16 — patch-only`, patch: `fontSize: theme.typography.pxToRem(15),\npadding: theme.spacing(1, 2),` },
      { key: "press", label: "Press scale (docs)", type: "number", default: 0.97, min: 0.9, max: 1, step: 0.005, target: { kind: "source", file: `${D}theme.ts`, line: "MuiButton &:active" }, mapsTo: `${D}theme.ts → MuiButton &:active scale(0.97) — patch-only`, patch: `"&:active": { transform: "scale(0.97)" },` },
    ],
  },
  {
    id: "icon-button",
    name: "IconButton",
    category: "buttons",
    status: "reused",
    sources: [`${D}theme.ts (MuiIconButton)`],
    usedIn: ["Global — close buttons, trailing actions, AudioPlayerPill, CopyableCommand, ListTile hover actions."],
    demo: "icon-button",
    spec: [
      radiusField("radius", "Corner radius", "MuiIconButton", 12),
      { key: "press", label: "Press scale (docs)", type: "number", default: 0.96, min: 0.9, max: 1, step: 0.005, target: { kind: "source", file: `${D}theme.ts`, line: "MuiIconButton &:active" }, mapsTo: `${D}theme.ts → MuiIconButton &:active scale(0.96) — patch-only`, patch: `"&:active": { transform: "scale(0.96)" },` },
    ],
  },
  {
    id: "fab",
    name: "Fab · AppFab",
    category: "buttons",
    status: "reused",
    sources: [`${D}theme.ts (MuiFab)`, `${D}components/common/AppFab.tsx`],
    usedIn: ["No call sites found under components/ for AppFab — likely legacy/reserved; MuiFab theme is global."],
    demo: "fab",
    spec: [
      radiusField("radius", "Fab radius", "MuiFab", 99),
      { key: "press", label: "Press scale (docs)", type: "number", default: 0.98, min: 0.9, max: 1, step: 0.005, target: { kind: "source", file: `${D}theme.ts`, line: "MuiFab &:active" }, mapsTo: `${D}theme.ts → MuiFab hover translateY(-1px), active scale(0.98) — patch-only`, patch: `"&:hover": { transform: "translateY(-1px)" },\n"&:active": { transform: "scale(0.98)" },` },
    ],
  },

  // ─── Forms ──────────────────────────────────────────────────────
  {
    id: "switch",
    name: "Switch (square)",
    category: "forms",
    status: "reused",
    sources: [`${D}theme.ts (MuiSwitch)`],
    usedIn: ["Global — every MUI Switch in settings/onboarding."],
    demo: "switch",
    spec: [
      radiusField("track-radius", "Track radius", "MuiSwitch", 5, "root", "& .MuiSwitch-track"),
      radiusField("thumb-radius", "Thumb radius", "MuiSwitch", 3, "root", "& .MuiSwitch-thumb"),
    ],
  },
  {
    id: "slider",
    name: "ElasticSlider",
    category: "forms",
    status: "reused",
    sources: [`${D}components/common/ElasticSlider.tsx`],
    usedIn: [`${D}components/settings/AppKeybindingsDialog.tsx`, `${D}components/settings/AudioDialog.tsx`],
    demo: "slider",
    spec: [
      { key: "thumb", label: "Thumb size (docs)", type: "number", default: 16, unit: "px", target: { kind: "source", file: `${D}components/common/ElasticSlider.tsx`, line: "buildElasticSliderSx" }, mapsTo: `${D}components/common/ElasticSlider.tsx → thumb 16px, white + 2px blue ring; rail/track 4px→6px on hover — patch-only`, patch: `"& .MuiSlider-thumb": { width: 16, height: 16, backgroundColor: "#FFFFFF", border: \`2px solid \${blue}\` },` },
      { key: "while-tap", label: "Press spring (docs)", type: "text", default: "scale 1.015 · 500/30", target: { kind: "source", file: `${D}components/common/ElasticSlider.tsx` }, mapsTo: `${D}components/common/ElasticSlider.tsx → whileTap scale 1.015, spring 500/30; static under reduced motion — patch-only`, patch: `whileTap: { scale: 1.015 },\ntransition: { type: "spring", stiffness: 500, damping: 30 },` },
    ],
  },
  {
    id: "segmented",
    name: "SegmentedControl",
    category: "forms",
    status: "reused",
    sources: [`${D}components/common/SegmentedControl.tsx`, `${D}styles/motion.ts (springSnappy)`],
    usedIn: [`${D}components/settings/AIAgentModeConfiguration.tsx`, `${D}components/settings/AIPostProcessingConfiguration.tsx`, `${D}components/settings/AITranscriptionConfiguration.tsx`, `${D}components/settings/MoreSettingsDialog.tsx`, `${D}components/settings/PillPlacementSetting.tsx`],
    demo: "segmented",
    spec: [
      { key: "indicator", label: "Indicator (docs)", type: "text", default: "layoutId springSnappy", target: { kind: "source", file: `${D}components/common/SegmentedControl.tsx`, line: "activeIndicator" }, mapsTo: `${D}components/common/SegmentedControl.tsx → shared-layout indicator (layoutId per instance), springSnappy; track radius 2 (16px), tab radius 1.5 (12px) — patch-only`, patch: `<Box component={motion.div} layoutId={layoutId} transition={springSnappy} … />` },
    ],
  },
  {
    id: "text-field",
    name: "TextField · Checkbox · Select (theme defaults)",
    category: "forms",
    status: "reused",
    sources: [`${D}theme.ts (no overrides — MUI defaults + Satoshi + cssVars)`, `${D}components/common/Section.tsx (checkbox toggle)`],
    usedIn: ["Global — login/signup forms, onboarding UserDetailsForm, settings provider fields, dictionary AddTermDialog."],
    demo: "text-field",
    spec: [
      { key: "note", label: "Note (docs)", type: "text", default: "MUI defaults", target: { kind: "source", file: `${D}theme.ts` }, mapsTo: `${D}theme.ts has no MuiTextField/MuiCheckbox overrides — inputs render MUI v9 defaults on the surface ladder. Add overrides here to restyle globally.`, patch: `MuiTextField: { styleOverrides: { root: ({ theme }) => ({ /* … */ }) } },` },
    ],
  },
  {
    id: "hotkey-badge",
    name: "HotkeyBadge · DictationInstruction",
    category: "forms",
    status: "recreated",
    statusNote: "HotkeyBadge imports getPrettyKeyName from utils/keyboard.utils, which pulls the zustand store + tauri invoke + platform utils — unsafe outside the app runtime. Recreated with identical Box styles; key labels use the same mapping rules copied from keyboard.utils (Key→letter, Meta/Ctrl/Shift/Alt glyphs, arrows).",
    sources: [`${D}components/common/HotkeyBadge.tsx`, `${D}components/common/DictationInstruction.tsx`, `${D}utils/keyboard.utils.ts (getPrettyKeyName)`],
    usedIn: [`${D}components/common/DictationInstruction.tsx`, `${D}components/dashboard/FeatureReleaseDialog.tsx`, `${D}components/onboarding/KeybindingsForm.tsx`, `${D}components/onboarding/TutorialForm.tsx`, `${D}components/styling/ManualStylingLayout.tsx`, `${D}components/home/HomePage.tsx (instruction)`, `${D}components/onboarding/TutorialForm.tsx (instruction)`],
    demo: "hotkey-badge",
    spec: [
      { key: "radius", label: "Badge radius", type: "radius", default: 4, min: 0, max: 12, step: 1, unit: "px", target: { kind: "recreated", key: "radius" }, mapsTo: `${D}components/common/HotkeyBadge.tsx → borderRadius 0.5 (4px). Live here; edit source to persist.`, patch: `borderRadius: 0.5, // theme.spacing → 4px` },
      { key: "weight", label: "Font weight (docs)", type: "number", default: 600, target: { kind: "source", file: `${D}components/common/HotkeyBadge.tsx` }, mapsTo: `${D}components/common/HotkeyBadge.tsx → fontWeight 600, px 1, py 0.25, 1px divider border, level1 bg — patch-only`, patch: `px: 1, py: 0.25, fontWeight: 600,\nborder: "1px solid", borderColor: "divider",` },
    ],
  },
  {
    id: "hotkey-recorder",
    name: "HotKey (recorder field)",
    category: "forms",
    status: "recreated",
    statusNote: "HotKey is store-bound (keysHeld, hotkeyStrategy, isRecordingHotkey, setSnackbar). Recreated with identical geometry/styles and a local key-capture shim; the pulseBorder keyframes are copied verbatim.",
    sources: [`${D}components/common/HotKey.tsx`],
    usedIn: [`${D}components/settings/DictationLanguageDialog.tsx`, `${D}components/settings/HotkeySetting.tsx`, `${D}components/settings/StyleHotkeysDialog.tsx`],
    demo: "hotkey-recorder",
    spec: [
      { key: "width", label: "Field width", type: "number", default: 200, min: 120, max: 320, step: 4, unit: "px", target: { kind: "recreated", key: "width" }, mapsTo: `${D}components/common/HotKey.tsx → width 200, height 40. Live here; edit source to persist.`, patch: `width: 200, height: 40,` },
      { key: "pulse", label: "Pulse (docs)", type: "text", default: "2s ease-in-out infinite", target: { kind: "source", file: `${D}components/common/HotKey.tsx`, line: "pulseBorder" }, mapsTo: `${D}components/common/HotKey.tsx → pulseBorder keyframes (blue 50% ↔ blue), 2s ease-in-out infinite while focused — patch-only`, patch: `animation: focused ? \`\${pulseBorder} 2s ease-in-out infinite\` : "none",` },
    ],
  },

  // ─── Dialogs & feedback ─────────────────────────────────────────
  {
    id: "dialog",
    name: "Dialog · DialogTitleWithClose",
    category: "dialogs",
    status: "reused",
    sources: [`${D}theme.ts (MuiDialog)`, `${D}components/common/DialogTitleWithClose.tsx`],
    usedIn: ["Global — every MUI Dialog.", `${D}components/settings/AIAgentModeDialog.tsx`, `${D}components/settings/AIPostProcessingDialog.tsx (+ title-with-close call sites)`],
    demo: "dialog",
    spec: [
      radiusField("radius", "Dialog radius", "MuiDialog", 18, "paper"),
    ],
  },
  {
    id: "confirm-dialog",
    name: "ConfirmDialog",
    category: "dialogs",
    status: "reused",
    sources: [`${D}components/common/ConfirmDialog.tsx`],
    usedIn: [`${D}components/onboarding/SignInForm.tsx`, `${D}components/settings/SettingsPage.tsx`, `${D}components/styling/ManualStylingRow.tsx`, `${D}components/tones/ToneEditorDialog.tsx`],
    demo: "confirm-dialog",
    spec: [
      { key: "layout", label: "Layout (docs)", type: "text", default: "xs fullWidth, dividers", target: { kind: "source", file: `${D}components/common/ConfirmDialog.tsx` }, mapsTo: `${D}components/common/ConfirmDialog.tsx → maxWidth xs fullWidth, DialogContent dividers, actions px3 pb2, text+contained buttons — patch-only`, patch: `<Dialog open maxWidth="xs" fullWidth>\n  <DialogTitle>{title}</DialogTitle>\n  <DialogContent dividers>…` },
    ],
  },
  {
    id: "popover-menu",
    name: "MenuPopover · MenuPopoverBuilder",
    category: "dialogs",
    status: "reused",
    sources: [`${D}theme.ts (MuiPopover)`, `${D}components/common/MenuPopover.tsx`],
    usedIn: [`${D}components/chats/ConversationListItem.tsx`, `${D}components/common/ContextMenu.tsx`, `${D}components/root/Header.tsx`, `${D}components/styling/AppStylingRow.tsx`, `${D}components/styling/ManualAddStyle.tsx`, `${D}components/styling/ManualStylingRow.tsx`, `${D}components/transcriptions/TranscriptionToneMenu.tsx`],
    demo: "popover-menu",
    spec: [
      radiusField("radius", "Popover radius", "MuiPopover", 14, "paper"),
    ],
  },
  {
    id: "context-menu",
    name: "ContextMenu · useContextMenu",
    category: "dialogs",
    status: "reused",
    sources: [`${D}components/common/ContextMenu.tsx`],
    usedIn: [`${D}components/chats/ChatMessageBubble.tsx`, `${D}components/chats/ConversationListItem.tsx`, `${D}components/dictionary/DictionaryRow.tsx`, `${D}components/root/Root.tsx (provider)`, `${D}components/styling/ManualStylingRow.tsx`, `${D}components/transcriptions/TranscriptRow.tsx`],
    demo: "context-menu",
    spec: [
      { key: "geometry", label: "Geometry (docs)", type: "text", default: "offset 4 · min-w 200", target: { kind: "source", file: `${D}components/common/ContextMenu.tsx` }, mapsTo: `${D}components/common/ContextMenu.tsx → MENU_OFFSET/padding clamp, min-width, max-height, item height — patch-only (read constants from source)`, patch: `// constants at top of ContextMenu.tsx\n// MENU_OFFSET, PADDING, MENU_MIN_WIDTH, MENU_MAX_HEIGHT, ITEM_HEIGHT` },
    ],
  },
  {
    id: "tooltip",
    name: "Tooltip · Conditional · ToolParams · Bouncy",
    category: "dialogs",
    status: "reused",
    sources: [`${D}theme.ts (MuiTooltip)`, `${D}components/common/ConditionalTooltip.tsx`, `${D}components/common/ToolParamsTooltip.tsx`, `${D}components/onboarding/BouncyTooltip.tsx`],
    usedIn: ["Global (MuiTooltip).", `${D}components/common/ToolPermissionPrompt.tsx (ToolParams)`, `${D}components/styling/PostProcessingDisabledTooltip.tsx (Conditional)`, `${D}components/onboarding/TutorialForm.tsx (Bouncy)`],
    demo: "tooltip",
    spec: [
      radiusField("radius", "Tooltip radius", "MuiTooltip", 10, "tooltip"),
      { key: "bounce", label: "Bouncy attention (docs)", type: "text", default: "1s bounce + 0.2s fade", target: { kind: "source", file: `${D}components/onboarding/BouncyTooltip.tsx` }, mapsTo: `${D}components/onboarding/BouncyTooltip.tsx → bounce 1s ease-in-out infinite + fadeIn 0.2s; exit fadeOutDown 0.2s; bounce dropped under reduced motion — patch-only`, patch: `bounce 1s ease-in-out infinite, fadeIn 0.2s ease-out both` },
    ],
  },
  {
    id: "snackbar",
    name: "Snackbar (emitter visual)",
    category: "dialogs",
    status: "recreated",
    statusNote: "SnackbarEmitter reads snackbar* fields from the zustand store. Recreated with the identical MUI Snackbar configuration (anchor, close behavior, content slot); message text #fff; mode fills from theme error/success/primary.",
    sources: [`${D}components/root/SnackbarEmitter.tsx`, `${D}utils/app.utils.ts (setSnackbar)`],
    usedIn: ["Global — any setSnackbar/showErrorSnackbar call site."],
    demo: "snackbar",
    spec: [
      { key: "duration", label: "Auto-hide (docs)", type: "number", default: 3000, unit: "ms", target: { kind: "source", file: `${D}utils/app.utils.ts`, line: "setSnackbar" }, mapsTo: `${D}utils/app.utils.ts → setSnackbar duration default 3000ms, mode info; clickaway ignored — patch-only`, patch: `draft.snackbarDuration = opts?.duration ?? 3000;\ndraft.snackbarMode = opts?.mode ?? "info";` },
    ],
  },
  {
    id: "feedback",
    name: "Progress · loading · empty states",
    category: "dialogs",
    status: "reused",
    sources: [`${D}components/common/AppCircularProgress.tsx`, `${D}components/common/CenterLoading.tsx`, `${D}components/common/CenterMessage.tsx`],
    usedIn: ["No call sites found under components/ for these three — reserved primitives (verify before deleting)."],
    demo: "feedback",
    spec: [
      { key: "layout", label: "Layout (docs)", type: "text", default: "centered stack", target: { kind: "source", file: `${D}components/common/CenterMessage.tsx` }, mapsTo: `CenterMessage: flex-1 centered, Container xs, Stack spacing 2, py 8. CenterLoading: full-height centered CircularProgress, pb 8 — patch-only`, patch: `// CenterMessage.tsx — flex: 1, minHeight 100%, centered` },
    ],
  },

  // ─── Data display ───────────────────────────────────────────────
  {
    id: "card-paper",
    name: "Card · Paper",
    category: "data",
    status: "reused",
    sources: [`${D}theme.ts (MuiCard, MuiPaper)`],
    usedIn: ["Global — cards, panels, table containers, wizard surfaces."],
    demo: "card-paper",
    spec: [
      radiusField("radius-card", "Card radius", "MuiCard", 16),
      { key: "hover", label: "Hover lift (docs)", type: "text", default: "-1px + hover shadow", target: { kind: "source", file: `${D}theme.ts`, line: "MuiCard &:hover" }, mapsTo: `${D}theme.ts → Card hover translateY(-1px) + premiumSurface.hover, 180/200ms easeOut — patch-only`, patch: `"&:hover": { transform: "translateY(-1px)", boxShadow: premiumSurface.light.hover },` },
    ],
  },
  {
    id: "list-tile",
    name: "ListTile",
    category: "data",
    status: "reused",
    sources: [`${D}theme.ts (MuiListItemButton, MuiListItemText)`, `${D}components/common/ListTile.tsx`, `${D}components/common/OverflowTypography.tsx`],
    usedIn: [`${D}components/common/MenuPopover.tsx`, `${D}components/dashboard/DashboardMenu.tsx`, `${D}components/dashboard/UpdateListTile.tsx`, `${D}components/settings/SettingsPage.tsx`, `${D}components/styling/AppStylingRow.tsx`, `${D}components/styling/ManualStylingRow.tsx`],
    demo: "list-tile",
    spec: [
      radiusField("radius", "Row radius", "MuiListItemButton", 14),
      { key: "press", label: "Press (docs)", type: "text", default: "scale 0.975 · 90ms", target: { kind: "source", file: `${D}components/common/ListTile.tsx`, line: "ListItemButton sx" }, mapsTo: `${D}components/common/ListTile.tsx → bg 100ms + transform 90ms var(--ease-out-cubic); active scale(0.975); transition none under reduced motion — patch-only`, patch: `transition: [theme.transitions.create("background-color", { duration: shortest }), "transform 90ms var(--ease-out-cubic)"]` },
    ],
  },
  {
    id: "table",
    name: "AppTable",
    category: "data",
    status: "reused",
    sources: [`${D}components/common/AppTable.tsx`],
    usedIn: ["No call sites found under components/ — reserved primitive (verify before deleting)."],
    demo: "table",
    spec: [
      { key: "layout", label: "Layout (docs)", type: "text", default: "virtuoso + weight cols", target: { kind: "source", file: `${D}components/common/AppTable.tsx` }, mapsTo: `${D}components/common/AppTable.tsx → react-virtuoso TableVirtuoso in Paper; weight/fixed col widths; header click toggles sort — patch-only`, patch: `// ColumnDef<T> { header, cell, getSortKey?, weight?, width? }` },
    ],
  },
  {
    id: "accordion",
    name: "Accordion",
    category: "data",
    status: "reused",
    sources: [`${D}theme.ts (MuiAccordion*)`],
    usedIn: ["Global — any MUI Accordion (settings groups, diagnostics)."],
    demo: "accordion",
    spec: [
      { key: "radius", label: "Radius (docs)", type: "number", default: 14, unit: "px", target: { kind: "source", file: `${D}theme.ts`, line: "MuiAccordion" }, mapsTo: `${D}theme.ts → MuiAccordion radius = shape.borderRadius (edit the Shape field on Typography spec for live) — patch-only here`, patch: `borderRadius: theme.shape.borderRadius,` },
    ],
  },
  {
    id: "stepper",
    name: "AppStepper",
    category: "data",
    status: "reused",
    sources: [`${D}components/common/AppStepper.tsx`],
    usedIn: ["No call sites found under components/ — reserved primitive (verify before deleting)."],
    demo: "stepper",
    spec: [
      { key: "pill", label: "Active pill (docs)", type: "text", default: "64px pill · scale 1.05", target: { kind: "source", file: `${D}components/common/AppStepper.tsx` }, mapsTo: `${D}components/common/AppStepper.tsx → active StepLabel pill radius 64, primary.main, label 18/600; hover scale 1.05; transitions 180ms short — patch-only`, patch: `borderRadius: "64px", backgroundColor: "primary.main",` },
    ],
  },
  {
    id: "breadcrumb",
    name: "Breadcrumb",
    category: "navigation",
    status: "reused",
    sources: [`${D}components/common/Breadcrumb.tsx`],
    usedIn: ["No call sites found under components/ — reserved primitive (verify before deleting)."],
    demo: "breadcrumb",
    spec: [
      { key: "layout", label: "Layout (docs)", type: "text", default: "body2 · / sep", target: { kind: "source", file: `${D}components/common/Breadcrumb.tsx` }, mapsTo: `${D}components/common/Breadcrumb.tsx → body2 links (secondary, underline on hover), current page primary/500, separator default "/" — patch-only`, patch: `separator = "/" // gap 0.5, px 2` },
    ],
  },
  {
    id: "typography-helpers",
    name: "Overflow · Edit · WithMore · CopyableCommand",
    category: "data",
    status: "reused",
    sources: [`${D}components/common/OverflowTypography.tsx`, `${D}components/common/EditTypography.tsx`, `${D}components/common/TypographyWithMore.tsx`, `${D}components/common/CopyableCommand.tsx`],
    usedIn: [`${D}components/chats/ChatMessageBubble.tsx (Overflow)`, `${D}components/common/ListTile.tsx (Overflow)`, `${D}components/transcriptions/TranscriptRow.tsx (WithMore)`, "EditTypography + CopyableCommand: no call sites found — reserved."],
    demo: "typography-helpers",
    spec: [
      { key: "copy", label: "Copy confirm (docs)", type: "text", default: "check 2000ms", target: { kind: "source", file: `${D}components/common/CopyableCommand.tsx` }, mapsTo: `${D}components/common/CopyableCommand.tsx → copied check (success.main, 16px) reverts after 2000ms — patch-only`, patch: `setTimeout(() => setCopied(false), 2000);` },
    ],
  },
  {
    id: "waveform",
    name: "AudioWaveform",
    category: "data",
    status: "reused",
    sources: [`${D}components/common/AudioWaveform.tsx`],
    usedIn: [`${D}components/microphone/MicrophoneTester.tsx`, `${D}components/onboarding/MicCheckForm.tsx`],
    demo: "waveform",
    spec: [
      { key: "physics", label: "Wave physics (docs)", type: "text", default: "3 waves · 0.18/0.985", target: { kind: "source", file: `${D}components/common/AudioWaveform.tsx` }, mapsTo: `${D}components/common/AudioWaveform.tsx → 3 waves (0.8/1.0/1.25 freq, opacities 1/0.78/0.56), smoothing 0.18, decay 0.985, stroke 1.6, 120×36 default — patch-only`, patch: `LEVEL_SMOOTHING = 0.18; TARGET_DECAY_PER_FRAME = 0.985;` },
    ],
  },
  {
    id: "logo",
    name: "Logo · LogoWithText",
    category: "data",
    status: "reused",
    sources: [`${D}components/common/Logo.tsx`, `${D}components/common/LogoWithText.tsx`, `${D}assets/app-logo-*.png`],
    usedIn: [`${D}components/root/TitleBar.tsx`, "Login/welcome surfaces."],
    demo: "logo",
    spec: [
      { key: "wordmark", label: "Wordmark (docs)", type: "text", default: "TAN-PARADISO", target: { kind: "source", file: `${D}components/common/LogoWithText.tsx` }, mapsTo: `${D}components/common/LogoWithText.tsx → TAN-PARADISO wordmark (display face allowed here) — patch-only`, patch: `// LogoWithText.tsx — fontFamily: var(--font-display)` },
    ],
  },

  // ─── Navigation ─────────────────────────────────────────────────
  {
    id: "dashboard-menu",
    name: "DashboardMenu (sidebar rail)",
    category: "navigation",
    status: "recreated",
    statusNote: "DashboardMenu reads the store (assistant-mode flag, update availability) and the app router. Recreated with identical rail wash, geometry, ListTile rows (real ListTile), MorphNavIcon glyphs (real), and the shared-layout active indicator (layoutId sidebar-active, springSnappy).",
    sources: [`${D}components/dashboard/DashboardMenu.tsx`, `${D}components/dashboard/UpdateListTile.tsx`],
    usedIn: [`${D}components/dashboard/DashboardPage.tsx`, `${D}components/root/AppSideEffects.tsx`],
    demo: "dashboard-menu",
    spec: [
      { key: "indicator-radius", label: "Indicator radius", type: "radius", default: 14, min: 0, max: 20, step: 1, unit: "px", target: { kind: "recreated", key: "indicatorRadius" }, mapsTo: `${D}components/dashboard/DashboardMenu.tsx → activeIndicator borderRadius 14px. Live here; edit source to persist.`, patch: `borderRadius: "14px", // activeIndicator` },
      { key: "rail", label: "Rail wash (docs)", type: "text", default: "gradient 180deg", target: { kind: "source", file: `${D}components/dashboard/DashboardMenu.tsx` }, mapsTo: `${D}components/dashboard/DashboardMenu.tsx → radius 16, margin 0.35rem, hairline 0.05, 180deg rail-wash gradient from surfaceAlpha ladder — patch-only`, patch: `background: linear-gradient(180deg, surfaceAlpha(level1, .7), surfaceAlpha(level0, .35)) // light` },
    ],
  },
  {
    id: "morph-icon",
    name: "MorphNavIcon",
    category: "navigation",
    status: "reused",
    sources: [`${D}components/common/MorphNavIcon.tsx`],
    usedIn: [`${D}components/dashboard/DashboardMenu.tsx`, `${D}components/root/TitleBar.tsx`],
    demo: "morph-icon",
    spec: [
      { key: "spring", label: "Morph spring (docs)", type: "text", default: "snappy · 22px · 1.85", target: { kind: "source", file: `${D}components/common/MorphNavIcon.tsx` }, mapsTo: `${D}components/common/MorphNavIcon.tsx → MorphIcon spring="snappy", size 22, strokeWidth 1.85 — patch-only`, patch: `<MorphIcon icon size={22} strokeWidth={1.85} spring="snappy" />` },
    ],
  },

  // ─── Layout ─────────────────────────────────────────────────────
  {
    id: "layout",
    name: "PageLayout · SplitLayout · Section · SettingSection · FadingScrollArea · ScrollListPage",
    category: "layout",
    status: "reused",
    sources: [`${D}components/common/PageLayout.tsx`, `${D}components/common/SplitLayout.tsx`, `${D}components/common/Section.tsx`, `${D}components/common/SettingSection.tsx`, `${D}components/common/FadingScrollArea.tsx`, `${D}components/common/ScrollListPage.tsx`],
    usedIn: [`${D}components/apps/AppsPage.tsx (ScrollList)`, `${D}components/dictionary/DictionaryPage.tsx (ScrollList)`, `${D}components/styling/*Layout.tsx (ScrollList)`, `${D}components/transcriptions/TranscriptionsPage.tsx (ScrollList)`, `${D}components/chats/ConversationLayout.tsx + ConversationListLayout.tsx (Fading)`, `${D}components/settings/*.tsx (Section/SettingSection)`, `${D}components/root/AppWrapper.tsx + ErrorBoundary.tsx (PageLayout)`],
    demo: "layout",
    spec: [
      { key: "row", label: "SettingSection row (docs)", type: "text", default: "row · space-between", target: { kind: "source", file: `${D}components/common/SettingSection.tsx` }, mapsTo: `${D}components/common/SettingSection.tsx → row Stack spacing 2, center/space-between; title body1/600, desc body2/secondary — patch-only`, patch: `<Stack direction="row" spacing={2} sx={{ alignItems: "center", justifyContent: "space-between" }}>` },
    ],
  },

  // ─── Chrome ─────────────────────────────────────────────────────
  {
    id: "titlebar",
    name: "TitleBar · ThemeModeToggle · WindowResizeHandles",
    category: "chrome",
    status: "reused",
    sources: [`${D}components/root/TitleBar.tsx`, `${D}components/root/ThemeModeToggle.tsx`, `${D}components/root/WindowResizeHandles.tsx`, `${D}utils/env.utils.ts (isTauriRuntime)`],
    usedIn: [`${D}components/common/PageLayout.tsx`, `${D}components/root/AppWrapper.tsx (via PageLayout)`],
    demo: "titlebar",
    spec: [
      { key: "height", label: "Bar height (docs)", type: "number", default: 40, unit: "px", target: { kind: "source", file: `${D}components/root/TitleBar.tsx` }, mapsTo: `${D}components/root/TitleBar.tsx → height 40 (DESIGN.md says ~46 — bar is 40 in code), level1 @ 0.88/0.92 alpha + blur(18px) saturate(1.2) + titleBarShadow — patch-only`, patch: `height: 40,\nbackgroundColor: surfaceAlpha(surfaces.light.level1, 0.88), // dark 0.92` },
      { key: "toggle", label: "Theme toggle (docs)", type: "text", default: "28px · 150ms", target: { kind: "source", file: `${D}components/root/ThemeModeToggle.tsx` }, mapsTo: `${D}components/root/ThemeModeToggle.tsx → 28×28, radius 1.5 (12px), transitions 150ms easeOut; menu items 16px icons — patch-only`, patch: `width: 28, height: 28, borderRadius: 1.5,` },
    ],
  },

  // ─── Pill-adjacent & app-bound ──────────────────────────────────
  {
    id: "native-pill",
    name: "Native overlay pill (dictation)",
    category: "pill",
    status: "recreated",
    statusNote: "Rendered by a separate native process (rust_macos_pill, Cairo canvas) outside the webview — direct reuse is impossible. Recreated in SVG/Canvas from exact constants in packages/rust_macos_pill/src/constants.rs + draw.rs (geometry, alphas, waveform physics, spring).",
    sources: ["packages/rust_macos_pill/src/constants.rs", "packages/rust_macos_pill/src/draw.rs", "packages/rust_macos_pill/src/state.rs", "packages/rust_macos_pill/src/gfx.rs", `${D}components/root/OverlaySyncSideEffects.ts (payload)`],
    usedIn: ["Native overlay window (phases: idle/recording/loading/paused; sizes: dictation/assistant_compact/expanded/typing). PillPlacementSetting configures placement."],
    demo: "native-pill",
    spec: [
      { key: "expanded-w", label: "Expanded width", type: "number", default: 120, min: 48, max: 200, step: 2, unit: "px", target: { kind: "recreated", key: "expandedW" }, mapsTo: `constants.rs → EXPANDED_PILL_WIDTH 120 (MIN 48). Live here; edit Rust + rebuild pill to persist.`, patch: `pub(crate) const EXPANDED_PILL_WIDTH: f64 = 120.0;` },
      { key: "expanded-h", label: "Expanded height", type: "number", default: 32, min: 6, max: 64, step: 1, unit: "px", target: { kind: "recreated", key: "expandedH" }, mapsTo: `constants.rs → EXPANDED_PILL_HEIGHT 32 (MIN 6). Live here; edit Rust + rebuild pill to persist.`, patch: `pub(crate) const EXPANDED_PILL_HEIGHT: f64 = 32.0;` },
      { key: "radius", label: "Corner radius cap", type: "radius", default: 16, min: 0, max: 24, step: 1, unit: "px", target: { kind: "recreated", key: "radius" }, mapsTo: `constants.rs → EXPANDED_RADIUS 16 (radius locked to shortest side via draw::pill_radius). Live here; edit Rust to persist.`, patch: `pub(crate) const EXPANDED_RADIUS: f64 = 16.0;` },
      { key: "bg-active", label: "BG alpha · active", type: "opacity", default: 0.92, min: 0, max: 1, step: 0.01, target: { kind: "recreated", key: "bgActive" }, mapsTo: `constants.rs → ACTIVE_BG_ALPHA 0.92 (IDLE 0.6), black fill; BORDER_ALPHA 0.3 white stroke. Live here; edit Rust to persist.`, patch: `pub(crate) const ACTIVE_BG_ALPHA: f64 = 0.92;` },
      { key: "spring", label: "Expand spring (docs)", type: "number", default: 200, target: { kind: "source", file: "packages/rust_macos_pill/src/constants.rs", line: "SPRING_STIFFNESS" }, mapsTo: `constants.rs → SPRING_STIFFNESS 200 — patch-only (native frame loop)`, patch: `pub(crate) const SPRING_STIFFNESS: f64 = 200.0;` },
    ],
  },
  {
    id: "assistant-panel",
    name: "Assistant panel (compact · expanded · typing)",
    category: "pill",
    status: "recreated",
    statusNote: "Same native process as the pill (rust_macos_pill draw.rs panel section) — direct reuse impossible. Recreated from exact PANEL_* constants (sizes, radius 24, bg 0.96, border 0.12, input 48, permission/review card geometry).",
    sources: ["packages/rust_macos_pill/src/constants.rs (PANEL_*)", "packages/rust_macos_pill/src/draw.rs (panel section)"],
    usedIn: ["Native overlay window (assistant_compact / assistant_expanded / assistant_typing sizes)."],
    demo: "assistant-panel",
    spec: [
      { key: "radius", label: "Panel radius", type: "radius", default: 24, min: 0, max: 32, step: 1, unit: "px", target: { kind: "recreated", key: "radius" }, mapsTo: `constants.rs → PANEL_RADIUS 24. Live here; edit Rust + rebuild pill to persist.`, patch: `pub(crate) const PANEL_RADIUS: f64 = 24.0;` },
      { key: "bg", label: "Panel BG alpha", type: "opacity", default: 0.96, min: 0, max: 1, step: 0.01, target: { kind: "recreated", key: "bg" }, mapsTo: `constants.rs → PANEL_BG_ALPHA 0.96 (black), PANEL_BORDER_ALPHA 0.12 white. Live here; edit Rust to persist.`, patch: `pub(crate) const PANEL_BG_ALPHA: f64 = 0.96;` },
      { key: "compact-w", label: "Compact width (docs)", type: "number", default: 424, unit: "px", target: { kind: "source", file: "packages/rust_macos_pill/src/constants.rs" }, mapsTo: `constants.rs → PANEL_COMPACT_WIDTH 424 / EXPANDED 572; window 452×144 / 600×282 / 600×362 — patch-only`, patch: `PANEL_COMPACT_WIDTH = 424.0; PANEL_EXPANDED_WIDTH = 572.0;` },
    ],
  },
  {
    id: "audio-player-pill",
    name: "AudioPlayerPill",
    category: "pill",
    status: "recreated",
    statusNote: "Loads audio bytes from the transcription repo + plays via WebAudio (actions/repos chain). Recreated with identical layout/styles/waveform-bar math (constants copied from audio-playback.utils) and a simulated progress clock.",
    sources: [`${D}components/transcriptions/AudioPlayerPill.tsx`, `${D}utils/audio-playback.utils.ts (bar constants)`],
    usedIn: [`${D}components/transcriptions/TranscriptRow.tsx`],
    demo: "audio-player-pill",
    spec: [
      { key: "max-width", label: "Max width", type: "number", default: 350, min: 200, max: 500, step: 10, unit: "px", target: { kind: "recreated", key: "maxWidth" }, mapsTo: `${D}components/transcriptions/AudioPlayerPill.tsx → maxWidth 350, radius 999, px1 py0.25, gap 1. Live here; edit source to persist.`, patch: `borderRadius: 999, maxWidth: 350,` },
      { key: "bars", label: "Bar math (docs)", type: "text", default: "2–4px bars · gap 2", target: { kind: "source", file: `${D}utils/audio-playback.utils.ts` }, mapsTo: `${D}utils/audio-playback.utils.ts → MIN 2 / MAX 4 wide, GAP 2, count 24–120 (default 58), height 35+value*55%, progress veil 140ms linear — patch-only`, patch: `WAVEFORM_BAR_MIN_WIDTH = 2; WAVEFORM_BAR_MAX_WIDTH = 4; WAVEFORM_BAR_GAP = 2;` },
    ],
  },
  {
    id: "tool-permission",
    name: "ToolPermissionPrompt · ToolPermissionCard",
    category: "pill",
    status: "recreated",
    statusNote: "Store-bound (permission queue state). Recreated from the exact sx in ToolPermissionPrompt (both overlay + inline variants) — font sizes, whites, icon sizes verified in source.",
    sources: [`${D}components/common/ToolPermissionPrompt.tsx`, `${D}components/chats/ToolPermissionCard.tsx`],
    usedIn: [`${D}components/chats/ToolPermissionCard.tsx (renders prompt)`],
    demo: "tool-permission",
    spec: [
      { key: "title-size", label: "Title size (docs)", type: "number", default: 13, unit: "px", target: { kind: "source", file: `${D}components/common/ToolPermissionPrompt.tsx` }, mapsTo: `${D}components/common/ToolPermissionPrompt.tsx → title 13/600, body 12, action icons 14 — patch-only`, patch: `<Typography sx={{ fontSize: 13, fontWeight: 600 }}>…` },
    ],
  },
  {
    id: "tone-select",
    name: "ToneSelect · TranscriptionToneMenu",
    category: "pill",
    status: "recreated",
    statusNote: "Store/action-bound (tone CRUD, user prefs). Recreated as the presentational slice: the real MenuPopover + ListTile rows + Add/Edit/Public icons with identical labeling; data is fixture tones.",
    sources: [`${D}components/tones/ToneSelect.tsx`, `${D}components/transcriptions/TranscriptionToneMenu.tsx`],
    usedIn: [`${D}components/styling/AppStylingLayout.tsx`, `${D}components/styling/AppStylingRow.tsx`, `${D}components/transcriptions/TranscriptionToneMenu.tsx`],
    demo: "tone-select",
    spec: [
      { key: "note", label: "Presentational slice (docs)", type: "text", default: "MenuPopover + ListTile", target: { kind: "source", file: `${D}components/tones/ToneSelect.tsx` }, mapsTo: `${D}components/tones/ToneSelect.tsx → menu built on MenuPopoverBuilder/ListTile; sorted tone ids via getSortedToneIds — edit radius via popover-menu spec (live), rows via list-tile spec (live)`, patch: `// rows: ListTile · menu: MenuPopoverBuilder` },
    ],
  },
  {
    id: "mic-check",
    name: "MicrophoneSelector · MicrophoneTester",
    category: "pill",
    status: "recreated",
    statusNote: "Calls native device enumeration (desktop-native-apis commands → tauri invoke) — unavailable in a plain browser. Recreated with identical control layout (real MUI Select + real AudioWaveform) and fixture devices.",
    sources: [`${D}components/microphone/MicrophoneSelector.tsx`, `${D}components/microphone/MicrophoneTester.tsx`],
    usedIn: [`${D}components/onboarding/MicCheckForm.tsx`, `${D}components/settings/MicrophoneDialog.tsx`],
    demo: "mic-check",
    spec: [
      { key: "note", label: "Presentational slice (docs)", type: "text", default: "Select + waveform", target: { kind: "source", file: `${D}components/microphone/MicrophoneSelector.tsx` }, mapsTo: `${D}components/microphone/MicrophoneSelector.tsx → MUI Select of native devices; tester pairs it with AudioWaveform(levels, active) — see waveform spec`, patch: `// devices: commands.* via @maus-inc/desktop-native-apis` },
    ],
  },
];

export const entryById = (id: string) => REGISTRY.find((e) => e.id === id);
export const entriesByCategory = (c: CategoryId) => REGISTRY.filter((e) => e.category === c);

/** Every registry entry whose demo renders the real component vs a recreation. */
export const REUSED = REGISTRY.filter((e) => e.status === "reused");
export const RECREATED = REGISTRY.filter((e) => e.status === "recreated");
