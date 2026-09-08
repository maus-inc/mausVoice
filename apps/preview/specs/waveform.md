# AudioWaveform (`waveform`)

- Status: **reused** — real component from `apps/desktop/src/components/common/AudioWaveform.tsx`.
- Source of truth: `apps/desktop/src/components/common/AudioWaveform.tsx`.
- Used in: MicrophoneTester, MicCheckForm. The native pill ports this physics (rust_macos_pill constants “ported from AudioWaveform.tsx”).

## Purpose
Live SVG level waves for mic input.

## Visual tokens
120×36 default (props), stroke 1.6, 3 waves (freq .8/1.0/1.25, mult 1.6/1.35/1.05, offsets 0/.85/1.7, opacity 1/.78/.56), ≥72 segments, round joins.

## Motion
rAF loop: smoothing 0.18 toward target, decay 0.985/frame, phase step 0.11 + gain 0.32×level, amplitude clamp .03–1.3, processing base level 0.16.

## States
active/live · idle · processing shimmer · custom stroke/size/baseline.

## Accessibility
Presentational canvas (verify aria-hidden at call sites).

## Live-spec mapping
Patch-only (physics in component). Persist → mic tester + mic check form. Pill must be re-ported by hand if physics changes.

