# mausVoice UI preview & spec site

Pixel-accurate, one-to-one preview and editing website for the mausVoice
desktop UI. Lives in `apps/preview/` — a **separate, additive surface**:
it never changes production behavior.

## Run it

```bash
# one-time: install + build the workspace libs the reused components import
pnpm install --ignore-scripts
pnpm --filter @maus-inc/types --filter @maus-inc/utilities \
  --filter @maus-inc/desktop-utils --filter @maus-inc/desktop-native-apis build

# develop (http://localhost:5193)
pnpm --filter @maus-inc/preview dev

# production bundle check
pnpm --filter @maus-inc/preview build
```

The dev server binds `0.0.0.0:5193` with `allowedHosts: true` so proxied
previews work.

## What it covers

40 registry entries (`apps/preview/src/lib/registry.ts`) across 9 categories:
foundations, buttons, forms, dialogs & feedback, data display, navigation,
layout, window chrome, pill-adjacent & app-bound.

- Each entry has **one detail page**: every state side by side
  (default, hover, focus, active, disabled, loading, error, empty — whichever
  apply), a **live spec editor**, the rendered spec file, and provenance
  (source of truth + every real-app usage path).
- **30 entries render the REAL components** imported from
  `apps/desktop/src` (plus the real theme, palette, shadows, motion tokens).
- **10 entries are pixel-spec recreations** (see below).

PR-diff note: this session's branch has **no open UI diff** (working tree
matches its base), so the site covers the full current tree. When a PR adds
or changes UI, add/extend the matching registry entry + `specs/*.md` (below).

## How to edit a spec (three surfaces)

1. **Live editor (in-browser, immediate).** On any detail page, change a
   field. `live` fields update **every instance site-wide at once**:
   - `palette` targets → scheme-scoped CSS variables (`--app-palette-*`),
   - `component`/`duration`/`easing`/`shape` targets → a derived MUI theme
     that wraps (never replaces) the real styleOverrides,
   - `recreated` targets → `useSpecValue()` inside recreated components.
   
   Overrides persist to `localStorage` (`maus-preview-spec-overrides-v1`).
   Reset per field, per component, or site-wide (header button).
2. **Spec files (human source of truth).** `apps/preview/specs/<id>.md` —
   purpose, usage paths, tokens, motion, states, a11y, live-spec mapping.
   Edit directly; the detail page renders the file (HMR in dev).
3. **Generator (consistency).** Specs are generated from
   `apps/preview/scripts/write-specs.mjs` — edit the script for bulk/format
   changes, then `pnpm --filter @maus-inc/preview gen:specs`.
   (The generator overwrites `specs/*.md`, so keep bespoke edits in the
   script if you re-run it.)

## How a spec edit maps back to the real app

Every editor field shows `→ <file> → <token>` plus:

- **Live fields**: the `Patch` button copies the exact source edit that
  persists the change (e.g. `theme.ts → MuiButton…borderRadius`).
- **Patch-only fields** (values hardcoded at call sites): the editor shows
  the **exact file + line context + snippet** instead of pretending to
  live-update, plus **every real-app file path that renders the component**
  (`usedIn`, from a name-grep over `apps/desktop/src/components`).

Workflow: tweak live → copy patch → apply to the cited file → the preview
and the app agree again (the preview reuses the same source).

## Reused vs recreated

**Reused directly** (real imports via the `@desktop` alias): color, type,
elevation, motion tokens, AnimateIn/AnimateSwitch, Button, IconButton,
Fab/AppFab, Switch, ElasticSlider, SegmentedControl, TextField defaults,
Dialog/DialogTitleWithClose, ConfirmDialog, MenuPopover(+Builder),
ContextMenu(+hook/provider), Tooltip/Conditional/ToolParams/BouncyTooltip,
AppCircularProgress/CenterLoading/CenterMessage, Card/Paper, ListTile,
AppTable, Accordion, AppStepper, Breadcrumb, Overflow/Edit/WithMore +
CopyableCommand, AudioWaveform, Logo(+WithText), MorphNavIcon, PageLayout,
SplitLayout, Section, SettingSection, FadingScrollArea, ScrollListPage,
TitleBar, ThemeModeToggle, WindowResizeHandles.

**Recreated** (direct reuse impossible — reason each):

| Entry | Reason direct reuse was impossible |
| --- | --- |
| `hotkey-badge` (+ DictationInstruction) | Imports `getPrettyKeyName` from `utils/keyboard.utils`, which pulls the zustand store + tauri invoke + platform utils. Styles copied verbatim; key glyphs copy the mapping rules. |
| `hotkey-recorder` | Reads `keysHeld`/`hotkeyStrategy`/`isRecordingHotkey` + `setSnackbar` from the store. Geometry/styles/keyframes copied verbatim; local key shim replaces the store. |
| `snackbar` | Reads all `snackbar*` fields from the store. Snackbar config copied verbatim. |
| `dashboard-menu` | Reads store (assistant-mode flag, update state) + app router. Rail/indicator copied verbatim; renders **real** ListTile + MorphNavIcon rows. |
| `native-pill` | Painted by a separate native process (`rust_macos_pill`, Cairo) outside the webview. Canvas recreation from exact Rust constants. Expand-spring damping is UNKNOWN (not in constants) — recreation uses critical damping; see spec. |
| `assistant-panel` | Same native process. DOM recreation from exact `PANEL_*` constants. Panel open/close curves UNKNOWN (not extracted). |
| `audio-player-pill` | Loads bytes from the transcription repo + WebAudio via repos/actions. Layout/bar math copied verbatim; simulated clock; seeded-PRNG outline stands in for content-derived bytes. |
| `tool-permission` | Store (`toolInfoById`) + actions (`resolveToolPermission`). Both variants’ `sx` copied verbatim; real ToolParamsTooltip inside. |
| `tone-select` | Store (tones, prefs) + actions (editor dialog). Render code copied verbatim with fixture tones; menus use real MenuPopoverBuilder + ListTile. |
| `mic-check` | Native device enumeration via tauri invoke. Render code copied verbatim with fixture devices; tester uses the real AudioWaveform. |

## Conventions for new components

1. Add the entry to `src/lib/registry.ts` (`sources`, `usedIn`, `spec`
   fields with `mapsTo` + `patch`).
2. Add the demo to `src/demos/<category>.tsx` + `src/demos/index.tsx`;
   prefer importing the real component from `@desktop/...`.
3. If reuse is impossible, recreate under `src/recreated/` from exact
   values only — mark anything underivable as UNKNOWN in the spec file.
4. Add the spec markdown to `scripts/write-specs.mjs` and run `gen:specs`.

Motion rules for anything new: framer-motion only, `springSnappy` for
chrome/shared-layout, tweens for fades/presses, 120–180ms ease-out for
tools, `prefers-reduced-motion` honored, no animation on keyboard-invoked
actions, never block input.
