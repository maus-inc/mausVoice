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
4. **Dictionary handling:** replacement rules correct or expand recognized text. Glossary context can help recognition where the provider supports it.
5. **Filtering:** the hallucination filter strips known silence-only phrases when enabled.
6. **Spoken commands:** when enabled and the dictation language is English or Auto, formatting commands like "new line" and "scratch that" are executed.
7. **Symbol conversions:** "hashtag" and "pound sign" are converted to `#`.
8. **Post-processing:** when enabled, a generative provider applies the active writing style. With post-processing off, the text from the previous stages is the output.
9. **Persistence:** unless Incognito suppresses it, the app stores the transcription record and attempts to retain its audio snapshot. Automatic cleanup keeps managed audio for only the 20 newest transcription rows that have audio.
10. **Delivery:** mausVoice writes to the clipboard and invokes the selected paste or simulated-typing strategy for the focused target.

The target application's focus matters at delivery time. If you start in one field and click elsewhere while a network provider is still processing, the later focus can receive the text.

A cancellation is different from a provider failure. Pressing **Escape** uses the cancel-transcription shortcut, while errors should leave diagnostic evidence or a failed status. Avoid repeatedly triggering the hotkey during cleanup; first wait for the pill to return to idle.
