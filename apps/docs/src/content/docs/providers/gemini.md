---
title: "Gemini"
description: "Configure Gemini audio transcription, post-processing, and Assistant generation."
sidebar:
  order: 6
---

Gemini is available in all three API-backed task dialogs. Add a Google AI API key, select the saved record separately for transcription, post-processing, or Assistant use, and choose a model for each task.

The built-in model lists currently include `gemini-2.5-flash`, `gemini-2.5-pro`, and `gemini-3-flash-preview` for transcription. Generation also offers `gemini-3-pro-preview` and `gemini-2.5-flash-lite`. The default for both paths is `gemini-2.5-flash`. Preview IDs can change provider-side; a saved ID is not a promise of continued availability.

## Audio path

Gemini transcription is not live. mausVoice converts recorded samples to WAV, divides longer input into 60-second segments with five seconds of overlap, and submits up to three segments in a batch. Each request includes inline base64 audio and an instruction to transcribe accurately. A specific language is added to that instruction; **Auto** leaves it open. Dictation context, when present, is appended as context.

Because the result arrives after upload and generation, Gemini cannot drive real-time segment output. Long recordings can use more requests than a single short clip.

## Generation and test

Post-processing combines system/style instructions with the transcript before calling Gemini. Assistant conversations use the streaming chat implementation and can carry function declarations for enabled tools.

**Test** asks `gemini-2.5-flash` to reply with "Hello." and checks for a non-empty matching response. It validates a small generation, not audio handling, the model selected elsewhere, quota for a long recording, or every tool call.

If a test passes but dictation fails, first try a brief clip with post-processing Off. An empty raw transcript points to transcription; a raw transcript paired with a failed final result points to the separate generation stage.
