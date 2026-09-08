# TextField · Checkbox · Select theme defaults (`text-field`)

- Status: **reused** — stock MUI v9 on the real theme (no overrides exist).
- Source of truth: `apps/desktop/src/theme.ts` (absence of overrides is the spec), `apps/desktop/src/components/common/Section.tsx` (checkbox toggle pattern).
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
Docs-only. To restyle globally add MuiTextField/MuiCheckbox overrides in `theme.ts` → all forms.

