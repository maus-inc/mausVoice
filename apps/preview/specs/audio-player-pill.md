# AudioPlayerPill (`audio-player-pill`)

- Status: **recreated** — loads bytes from the transcription repo + WebAudio (repos/actions chain). Recreation copies layout/styles/bar math; playback is a simulated clock.
- Source of truth: `apps/desktop/src/components/transcriptions/AudioPlayerPill.tsx`, `apps/desktop/src/utils/audio-playback.utils.ts`.
- Used in: `apps/desktop/src/components/transcriptions/TranscriptRow.tsx`.

## Purpose
Inline recording playback with waveform + progress veil.

## Visual tokens
Flex row, radius 999, 1px divider border, level1, px 1 py .25, gap 1, maxWidth 350. Play/pause IconButton small p .5, localized labels. Duration body2 secondary tnum minWidth 42. Waveform h 22 flex 1: bars width clamp 2–4 gap 2 count 24–120 (default 58 when unmeasured), radius spacing .25, primary.main, height 35+value×55%; veil level1 @.5 from progress% with left 140ms linear.

## Motion
Veil left 140ms linear; bar opacity 140ms ease. ResizeObserver recomputes count/width.

## States
idle / playing / paused / ended (reset) / disabled / null duration (“0:00”) / error → error snackbar (store path, not simulated).

## Accessibility
Play/pause has localized aria-labels; progress is visual-only (verify live-region needs).

## Live-spec mapping
Max width live (recreated). Bar math patch-only: edit `AudioPlayerPill.tsx` / `audio-playback.utils.ts` → TranscriptRow. NOTE: bar outline here is a seeded PRNG keyed by id; production derives it from content (buildWaveformOutline).

