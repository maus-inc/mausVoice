# Motion tokens & transitions (`motion`)

- Status: **reused** — values from `apps/desktop/src/styles/motion.ts` + `theme.ts` transitions + `fonts.css` vars.
- Source of truth: `apps/desktop/src/styles/motion.ts`, `apps/desktop/src/theme.ts` (transitions), `apps/desktop/src/styles/fonts.css` (:root vars).
- Used in: AnimateIn/AnimateSwitch, SegmentedControl, DashboardMenu, DashboardPage, TutorialForm, UnlockedProForm, ElasticSlider, ListTile, AppFab, AppStepper, ThemeModeToggle, HotKey.

## Purpose
Emil Kowalski-grade timing: purposeful cubic-beziers, springs for chrome/shared-layout, tweens for fades/presses. Tool rule: 120–180ms ease-out, no spring-bounce; keyboard-invoked actions never animate; reduced motion honored everywhere.

## Visual tokens
Durations: shortest 100 · shorter 150 · short 180 · standard 220 · complex 280 · enteringScreen 250 · leavingScreen 180 (ms). motion.ts mirrors in seconds: instant .1 · fast .15 · base .2 · enter .25 · exit .18. Easings: easeOut `cubic-bezier(0.23,1,0.32,1)` · sharp `cubic-bezier(0.33,1,0.68,1)` · easeInOut `cubic-bezier(0.645,0.045,0.355,1)`. Springs: snappy `{420, 32, 0.8}` · soft `{280, 28, 0.9}`. CSS vars: `--ease-out-quint/cubic/in-out`, `--duration-fast/base/enter/exit`.

## Motion
Springs drive AnimateIn/AnimateSwitch enter-exit, segmented + sidebar shared-layout indicators. Tweens drive press feedback (scale .96–.98, 90–150ms), hovers (150–200ms), dialog/popover enter/exit (250/180ms).

## States
Full motion / reduced motion (springs → opacity fades; ListTile transitions off; bounce dropped; AnimateSwitch renders keyed static).

## Accessibility
`prefers-reduced-motion` honored in every animated component; global CSS kill-switch in MuiCssBaseline; keyboard-invoked actions skip animation.

## Live-spec mapping
All duration/easing fields are live (derived theme) — framer-motion springs read from `motion.ts` are patch-only (edit constants, rebuild). Persist: `theme.ts` transitions + `motion.ts`, affecting all listed consumers.

