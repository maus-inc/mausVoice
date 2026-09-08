# AppStepper (`stepper`)

- Status: **reused** — real component from `apps/desktop/src/components/common/AppStepper.tsx`.
- Source of truth: `apps/desktop/src/components/common/AppStepper.tsx`.
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

