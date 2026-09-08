# Button — contained · text · flat · blue (`button`)

- Status: **reused** — real MUI Button + real theme overrides.
- Source of truth: `apps/desktop/src/theme.ts` (MuiButton).
- Used in: every MUI Button app-wide (dialog actions, forms, onboarding, settings).

## Purpose
Primary actions. contained = main CTA (ink/white); text = quiet; flat = machined surface; blue = the single accent CTA.

## Visual tokens
Root: radius 12 · 600 · 15px · padding 8/16 · icons 22px · ripple off · elevation off. contained: ink base/`#FDFBF8` text (light), white/`#0C0C0D` (dark); flat: level1→2→3; blue: blue/blueHover/blueActive + onBlue text + accentSurface. Hover: contained/flat lift −1px + hover shadow; text hovers level2, actives level3.

## Motion
Root transition: transform 120ms + bg/color 180ms + shadow 200ms, all easeOut. Press: scale(0.97) root; contained/flat/blue press scale(0.98) + active shadow. No input blocking; hover responds on pointerenter.

## States
default / hover / focus-visible (global 2px brand ring, offset 2) / active / disabled (MUI) / loading (app pattern: disabled + spinner + label swap).

## Accessibility
Real `<button>`; disabled state announced; focus-visible ring designed (accent-tinted, 2px, offset 2). Loading keeps the label live text.

## Live-spec mapping
Radius is live (derived theme → every Button). Font/press values patch-only: edit `theme.ts` MuiButton, affecting all buttons.

