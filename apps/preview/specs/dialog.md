# Dialog · DialogTitleWithClose (`dialog`)

- Status: **reused** — real MUI Dialog theme + real `DialogTitleWithClose`.
- Source of truth: `apps/desktop/src/theme.ts` (MuiDialog, MuiDialogActions), `apps/desktop/src/components/common/DialogTitleWithClose.tsx`.
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

