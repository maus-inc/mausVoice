---
title: "Gemini"
description: "Configure Gemini audio transcription, post-processing, and Assistant generation."
sidebar:
  order: 6
---

Gemini is available in all three API-backed task dialogs. Add a Google AI API key, select the saved record separately for transcription, post-processing, or Assistant use, and choose a model for each task.

The model pickers query Google's live model catalog and accept general Gemini models that advertise `generateContent`, plus any model whose ID contains `-transcribe`. Entries carrying a `-audio`, `-computer-use`, `-embedding`, `-image`, `-live`, `-native-audio`, `-omni-`, `-robotics`, or `-tts` marker are excluded, as are the `-thinking` and `-search` variants, which are not served through the audio path. Because `-live` is excluded, there is no transcribe-live exception to make. The offline fallbacks are `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`, and `gemini-3.5-transcribe`, with defaults `gemini-3.8-flash` for generation and `gemini-3.5-transcribe` for transcription. Only `gemini-3.5-transcribe` is a dedicated transcribe model, and it is the only one that accepts dictionary terms; a general model chosen for transcription records a warning on the history row instead of silently dropping them. Preview IDs can still change provider-side; a saved ID is not a promise of continued availability.

## Audio path

Gemini transcription is not live. mausVoice converts recorded samples to WAV, divides longer input into 60-second segments with five seconds of overlap, and submits up to three segments in a batch.

- **General models** (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`): each request includes inline base64 audio and an instruction to transcribe accurately. A specific language is added to that instruction; **Auto** leaves it open. Dictation context, when present, is appended as context.
- **Dedicated transcribe model** (`gemini-3.5-transcribe`): uses the Files API resumable upload (`/upload/v1beta/files`) to obtain a file URI, then calls `models/gemini-3.5-transcribe:generateContent` with `fileData` and `generationConfig.audioTranscriptionConfig`. Language is sent as `languageCodes` (BCP-47, e.g. `en-US`) and dictionary entries are sent as `customVocabulary` (up to 1000 terms, best <=100). mausVoice always requests `VERBATIM`, which preserves filler and formatting for downstream post-processing: it does not expose a `SMART` mode or the diarization and word-timestamp options, so the vocabulary and mode fallbacks those options imply are not reachable from the app. Uploaded files are polled until `ACTIVE` and deleted after transcription to avoid storage leaks. If the upload fails for any reason, including a 4xx, the request falls back to inline audio, which cannot recover a recording over the inline size limit.

Because the result arrives after upload and generation, Gemini cannot drive real-time segment output. Long recordings can use more requests than a single short clip. The dedicated transcribe model supports up to 1 hour per request (30 minutes with diarization or timestamps) and provides higher accuracy for speech-to-text than general flash models.

## Generation and test

Post-processing combines system/style instructions with the transcript before calling Gemini. Assistant conversations use the streaming chat implementation and can carry function declarations for enabled tools. Model discovery, transcription, generation, and streaming all use the desktop HTTP transport rather than the webview's browser transport.

**Test** authenticates by listing models through the same desktop HTTP transport, so it no longer spends tokens or depends on one fixed Gemini model. It does not validate audio handling, the model selected elsewhere, quota for a long recording, or every tool call.

If a test passes but dictation fails, first try a brief clip with post-processing Off. An empty raw transcript points to transcription; a raw transcript paired with a failed final result points to the separate generation stage.
