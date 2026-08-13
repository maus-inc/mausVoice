---
title: "Speaches"
description: "Connect mausVoice to a separately operated Speaches transcription server and model."
sidebar:
  order: 10
---

Speaches is a self-hosted **transcription-only** route. It is separate from mausVoice's bundled Local mode: you install, expose, secure, and load models in the Speaches server yourself.

Add it under **Settings → Processing → AI transcription → API**. The form defaults to `http://localhost:8000` and `Systran/faster-whisper-large-v3`; it does not ask for an API key. **Test** calls `/health`. During transcription, mausVoice posts multipart WAV audio to `/v1/audio/transcriptions` with the configured model plus language and dictionary-derived prompt when present.

Ordinary Speaches dictation uses retained-audio batch processing after release. Recordings longer than 60 seconds are divided into 60-second segments with five seconds of overlap, up to three requests run concurrently, and overlapping text is merged. It does not provide mausVoice's real-time committed-segment output.

A passing health check proves only that the endpoint answers. Confirm the model ID exists in the server's `/v1/models` catalog and make a short dictation. Because mausVoice sends no Speaches authorization header, do not expose the default service directly to an untrusted network. Put authentication/TLS in a controlled proxy if needed and account for that proxy when choosing the base URL.

`localhost` means the computer running the desktop app, not an unrelated Docker container or another device. Publish the container port to that host, or use a reachable hostname. Avoid a trailing path that already includes `/v1`; mausVoice appends the runtime paths itself.
