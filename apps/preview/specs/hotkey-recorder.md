# HotKey recorder field (`hotkey-recorder`)

- Status: **recreated** — store-bound (keysHeld, hotkeyStrategy, isRecordingHotkey, setSnackbar). Recreation copies geometry/styles/keyframes verbatim; a local key-capture shim stands in for the store.
- Source of truth: `apps/desktop/src/components/common/HotKey.tsx`.
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
Width live (recreated). Pulse + commit logic patch-only: edit `HotKey.tsx` → the three settings dialogs.

