---
title: "Gemini"
description: "Configure Gemini audio transcription, post-processing, and Assistant generation."
sidebar:
  order: 6
---

Gemini is available in all three API-backed task dialogs. Add a Google AI API key, select the saved record separately for transcription, post-processing, or Assistant use, and choose a model for each task.

The model pickers query Google's live model catalog and accept general Gemini models that advertise `generateContent`, rather than intersecting the response with a frozen allowlist. Specialized image, embedding, live, TTS, robotics, and computer-use entries are excluded. The offline fallbacks include the current Gemini 3 generation, and the default for transcription and generation is `gemini-3.7-flash`. Preview IDs can still change provider-side; a saved ID is not a promise of continued availability.

## Audio path

Gemini transcription is not live. mausVoice converts recorded samples to WAV, divides longer input into 60-second segments with five seconds of overlap, and submits up to three segments in a batch. Each request includes inline base64 audio and an instruction to transcribe accurately. A specific language is added to that instruction; **Auto** leaves it open. Dictation context, when present, is appended as context.

Because the result arrives after upload and generation, Gemini cannot drive real-time segment output. Long recordings can use more requests than a single short clip.

## Generation and test

Post-processing combines system/style instructions with the transcript before calling Gemini. Assistant conversations use the streaming chat implementation and can carry function declarations for enabled tools. Model discovery, transcription, generation, and streaming all use the desktop HTTP transport rather than the webview's browser transport.

**Test** authenticates by listing models through the same desktop HTTP transport, so it no longer spends tokens or depends on one fixed Gemini model. It does not validate audio handling, the model selected elsewhere, quota for a long recording, or every tool call.

If a test passes but dictation fails, first try a brief clip with post-processing Off. An empty raw transcript points to transcription; a raw transcript paired with a failed final result points to the separate generation stage.
