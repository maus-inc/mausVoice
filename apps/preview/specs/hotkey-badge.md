# HotkeyBadge · DictationInstruction (`hotkey-badge`)

- Status: **recreated** — HotkeyBadge imports `getPrettyKeyName` from `utils/keyboard.utils`, which pulls the zustand store + tauri invoke + platform utils (unsafe in a plain browser). Recreation copies the Box styles verbatim; key labels copy the mapping rules.
- Source of truth: `apps/desktop/src/components/common/HotkeyBadge.tsx`, `apps/desktop/src/components/common/DictationInstruction.tsx`, `apps/desktop/src/utils/keyboard.utils.ts:168-200`.
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
Badge radius live (recreated). Weight/spacing patch-only: edit `HotkeyBadge.tsx` → all listed call sites.

