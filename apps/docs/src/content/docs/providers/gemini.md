---
title: "Gemini"
description: "Configure Gemini audio transcription, post-processing, and Assistant generation."
sidebar:
  order: 6
---

Gemini is available in all three API-backed task dialogs. Add a Google AI API key, select the saved record separately for transcription, post-processing, or Assistant use, and choose a model for each task.

The model pickers query Google's live model catalog and accept general Gemini models that advertise `generateContent`, plus the dedicated `gemini-3.5-transcribe` model. Specialized image, embedding, live (except transcribe-live excluded from file transcription), TTS, robotics, and computer-use entries are excluded. The offline fallbacks include `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, and `gemini-3.5-transcribe`, with defaults `gemini-3.8-flash` for generation and `gemini-3.5-transcribe` for transcription. Preview IDs can still change provider-side; a saved ID is not a promise of continued availability.

## Audio path

Gemini transcription is not live. mausVoice converts recorded samples to WAV, divides longer input into 60-second segments with five seconds of overlap, and submits up to three segments in a batch.

- **General models** (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`): each request includes inline base64 audio and an instruction to transcribe accurately. A specific language is added to that instruction; **Auto** leaves it open. Dictation context, when present, is appended as context.
- **Dedicated transcribe model** (`gemini-3.5-transcribe`): uses the Files API resumable upload (`/upload/v1beta/files`) to obtain a file URI, then calls `models/gemini-3.5-transcribe:generateContent` with `fileData` and `generationConfig.audioTranscriptionConfig`. Language is sent as `languageCodes` (BCP-47, e.g. `en-US`), dictionary entries are sent as `customVocabulary` (up to 1000 terms, best <=100), and mode defaults to `VERBATIM` for verbatim transcription (preserves filler and formatting for downstream post-processing). `SMART` can be requested for filler removal, but when diarization or word timestamps are enabled, custom vocabulary is dropped and mode falls back to `VERBATIM` per API constraints. Uploaded files are polled until `ACTIVE` and deleted after transcription to avoid storage leaks.

Because the result arrives after upload and generation, Gemini cannot drive real-time segment output. Long recordings can use more requests than a single short clip. The dedicated transcribe model supports up to 1 hour per request (30 minutes with diarization or timestamps) and provides higher accuracy for speech-to-text than general flash models.

## Generation and test

Post-processing combines system/style instructions with the transcript before calling Gemini. Assistant conversations use the streaming chat implementation and can carry function declarations for enabled tools. Model discovery, transcription, generation, and streaming all use the desktop HTTP transport rather than the webview's browser transport.

**Test** authenticates by listing models through the same desktop HTTP transport, so it no longer spends tokens or depends on one fixed Gemini model. It does not validate audio handling, the model selected elsewhere, quota for a long recording, or every tool call.

If a test passes but dictation fails, first try a brief clip with post-processing Off. An empty raw transcript points to transcription; a raw transcript paired with a failed final result points to the separate generation stage.
