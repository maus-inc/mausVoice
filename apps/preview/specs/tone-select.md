# ToneSelect · TranscriptionToneMenu (`tone-select`)

- Status: **recreated slice** — store/action-bound (tone CRUD, prefs). Recreation copies the render code; fixture tones; menus compose the REAL MenuPopoverBuilder + ListTile.
- Source of truth: `apps/desktop/src/components/tones/ToneSelect.tsx`, `apps/desktop/src/components/transcriptions/TranscriptionToneMenu.tsx`.
- Used in: AppStylingLayout, AppStylingRow, TranscriptionToneMenu.

## Purpose
Style picker (select + row-menu variants) with create/edit affordances.

## Visual tokens
FormControl + displayEmpty Select; “New style” row (Add small); tone rows: name + global Public tooltip (“cannot be edited”) or Edit IconButton (stops propagation, closes menu, opens editor dialog); system tones show neither; empty value renders “Default” / “Default ({toneName})”.

## Motion
MUI select/menu motion; sorted ids via getSortedToneIds.

## States
empty default / selected / disabled / global/system/custom rows / menu open-closed.

## Accessibility
MUI select semantics + labels; per-row edit buttons stop propagation (verify focus return after dialog).

## Live-spec mapping
Docs-only slice. Radii/motion follow popover-menu + list-tile + text-field specs (live there). Persist: edit `ToneSelect.tsx` → styling + transcription call sites.

