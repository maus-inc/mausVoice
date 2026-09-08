# MicrophoneSelector · MicrophoneTester (`mic-check`)

- Status: **recreated slice** — native device enumeration via @maus-inc/desktop-native-apis (tauri invoke) is unavailable in a browser. Recreation copies render code; fixtures; REAL AudioWaveform in the tester.
- Source of truth: `apps/desktop/src/components/microphone/MicrophoneSelector.tsx`, `MicrophoneTester.tsx`.
- Used in: MicCheckForm, MicrophoneDialog.

## Purpose
Device picker + live input test.

## Visual tokens
Stack spacing 1.5; fullWidth small FormControl + “Microphone” label; Automatic row + Recommended filled chip; divider my .5; device rows: label + unavailable (warning caption) / caution (secondary caption) + Default (primary outlined) / Caution (warning outlined) chips; Refresh text button + 18px spinner; error Alert.

## Motion
MUI select/menu; spinner while enumerating.

## States
default / loading / error / disabled / unavailable + caution devices / tester waveform live.

## Accessibility
Labelled select; status captions are text (verify live-region for enumeration state).

## Live-spec mapping
Docs-only slice. Persist: edit `MicrophoneSelector.tsx` → MicCheckForm + MicrophoneDialog. Waveform physics: see waveform spec.

