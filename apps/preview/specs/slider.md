# ElasticSlider (`slider`)

- Status: **reused** — real component from `apps/desktop/src/components/common/ElasticSlider.tsx`.
- Source of truth: `apps/desktop/src/components/common/ElasticSlider.tsx`.
- Used in: `apps/desktop/src/components/settings/AppKeybindingsDialog.tsx`, `apps/desktop/src/components/settings/AudioDialog.tsx`.

## Purpose
Accent-filled slider with a blooming thumb and 1:1 drag tracking (local drag value; `onCommit` on release/keyboard).

## Visual tokens
Rail/track 4px radius 99 (rail level3, track blue, no border) → 6px on container hover (160ms easeOut). Thumb 16px white circle, 2px blue ring, `0 1px 3px rgba(0,0,0,.25)`; hover scale 1.15 + 6px blue 14% halo; drag scale 1.25 + 8px blue 18% halo; focus-visible 3px blue 40% ring. Thumb transforms must re-compose `translate(-50%,-50%)` (THUMB_CENTER_TRANSFORM).

## Motion
Thumb transform/shadow 160ms easeOut; container `whileTap: scale 1.015` spring {500, 30} — static plain div under reduced motion.

## States
default / hover / drag / keyboard / focus-visible / disabled (MUI) / value-label auto.

## Accessibility
MUI Slider semantics: `aria-label` prop, arrow-key support, value text via valueLabelFormat. onCommit (not onChange) persists — screen-reader announcements follow MUI value text.

## Live-spec mapping
Patch-only (sx builder in the component). Persist: edit `ElasticSlider.tsx` → the two settings dialogs.

