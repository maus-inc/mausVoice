---
title: Transcription
description: Learn about mausVoice's transcription modes and how to choose the right one.
---

mausVoice supports three transcription modes. You can switch between them at any time from the settings page.

## Local

Local mode runs transcription entirely on your device using [Whisper](https://github.com/openai/whisper). Nothing leaves your machine.

- On first use, mausVoice downloads a Whisper model. The default is `tiny` (~77 MB); larger models (`base`, `small`, `medium`, `turbo`, and `large`) are available for higher accuracy.
- Models are stored in your app data directory under `transcription-models/`.
- GPU acceleration is used automatically when available (Metal on macOS, Vulkan on Windows/Linux).
- You can force CPU-only inference by disabling GPU in settings.

Local mode is ideal when privacy is a priority or when you don't have a reliable internet connection.

## API

API mode sends your audio to the transcription provider of your choice — for example Groq's Whisper, Deepgram (`nova-3`), or OpenAI's Whisper. This requires an API key from that provider, which you can add in settings.

- Your API key is encrypted and stored locally.
- Transcription quality is generally higher than the local `tiny` model since it uses a larger model.
- Requires an internet connection.

## Cloud

Cloud mode routes audio through mausVoice's cloud service, which handles the Groq API call on your behalf. This is the simplest option — no API key needed.

## Choosing a Mode

| Consideration     | Local | API  | Cloud |
| ----------------- | ----- | ---- | ----- |
| Privacy           | Best  | Good | Good  |
| Accuracy          | Good  | Best | Best  |
| Internet required | No    | Yes  | Yes   |
| API key required  | No    | Yes  | No    |
