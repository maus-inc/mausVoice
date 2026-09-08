# ConfirmDialog (`confirm-dialog`)

- Status: **reused** — real component from `apps/desktop/src/components/common/ConfirmDialog.tsx`.
- Source of truth: `apps/desktop/src/components/common/ConfirmDialog.tsx`.
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
Patch-only. Persist: edit `ConfirmDialog.tsx` → four call sites. Radii follow the dialog + button specs (live).

