---
title: "Deepgram"
description: "Configure Nova-3 streaming dictation, language handling, and the Personal Deepgram shortcut."
sidebar:
  order: 4
---

Deepgram is a transcription-only provider in mausVoice. Get a key from the [Deepgram console](https://console.deepgram.com/), then save it through **Settings → Processing → Deepgram API key** or add a named record in **AI transcription**.

The quick row creates or updates **Personal Deepgram** and prefers it for transcription when the current choice is unset, Local, or already one of the managed personal records. It does not replace an unrelated provider you deliberately selected.

## Recording path

Normal microphone recording opens a secure WebSocket to Deepgram and streams 16-bit PCM audio. The implementation currently fixes the model to `nova-3`, requests punctuation, smart formatting, interim results, and 300 ms endpointing, then assembles final segments when recording stops. Committed segments can feed mausVoice's optional real-time output path.

The **Model** field on a saved record also defaults to `nova-3`. The separate HTTP batch route uses it, for example when transcribing a stored audio blob. The normal live session does not; its model is currently fixed in code.

With language **Auto**, the live session sends Deepgram's `multi` setting. That supports multilingual switching for a defined set that includes English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, and Dutch, but not Chinese. Select a specific Chinese locale instead. The batch route asks Deepgram to detect the language when Auto is selected.

## Test and troubleshooting

**Test** attempts to open a five-second `nova-3` WebSocket and treats a successful connection as valid. It sends no meaningful speech, so it does not validate recognition quality, quota for a complete session, the selected language, or the record's typed model.

If a live session cannot be established, the recording result carries a warning rather than silently switching to local transcription. Check the History entry, test the key again, confirm network access to `wss://api.deepgram.com`, and retry with a short recording. Post-processing is a separate second request to whichever generative provider you selected.
