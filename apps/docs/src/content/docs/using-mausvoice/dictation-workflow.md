---
title: "The dictation workflow"
description: "Follow audio through recording, transcription, optional rewriting, history, and insertion."
sidebar:
  order: 2
---

A dictation crosses distinct stages, and most configuration and troubleshooting questions come down to which stage is involved.

1. **Trigger:** the global hold-to-dictate shortcut starts capture.
2. **Capture:** the selected microphone supplies audio while the shortcut remains held.
3. **Transcription:** either the local Whisper sidecar or an API provider converts audio into raw text.
4. **Dictionary handling:** glossary context can help recognition where supported, and replacement rules correct or expand recognized text before the optional rewrite.
5. **Post-processing:** when enabled, a generative provider applies the active writing style. With post-processing off, raw text remains the output.
6. **Persistence:** unless Incognito suppresses it, the app stores the transcription record and attempts to retain its audio snapshot. Automatic cleanup keeps managed audio for only the 20 newest transcription rows that have audio.
7. **Delivery:** mausVoice writes to the clipboard and invokes the selected paste or simulated-typing strategy for the focused target.

The target application's focus matters at delivery time. If you start in one field and click elsewhere while a network provider is still processing, the later focus can receive the text.

A cancellation is different from a provider failure. Pressing **Escape** uses the cancel-transcription shortcut, while errors should leave diagnostic evidence or a failed status. Avoid repeatedly triggering the hotkey during cleanup; first wait for the pill to return to idle.
