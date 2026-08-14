---
title: "Aldea, ElevenLabs, xAI, DeepSeek, Cerebras, and AssemblyAI"
description: "Use the remaining registered providers with their exact task, model, transport, and test behavior."
sidebar:
  order: 11
---

These providers use the standard one-key form, but support different tasks. Task filtering matters more than a successful key test.

## Transcription providers

### Aldea

Aldea is batch transcription only. mausVoice sends raw WAV bytes to `https://api.aldea.ai/v1/listen` with Bearer authentication, using 60-second segments, five-second overlaps, and batches of three concurrent calls. The implementation currently ignores the selected language and dictionary prompt. Its key test sends an empty body and treats either success or HTTP 400 as evidence that the endpoint was reached, so validate with real speech too.

### ElevenLabs

Normal dictation obtains a single-use token, opens the `scribe_v2_realtime` WebSocket, and sends base64 PCM16 audio with VAD commits. It reports committed segments for optional real-time output and waits up to six seconds for finalization. If that streaming session cannot start or finish, the current session returns a warning and no transcript; it does not retry the recording through another provider.

Stored-clip/batch transcription uses `scribe_v1` instead, with the same 60/5-second segmentation policy as other batch providers. The key test calls the ElevenLabs user endpoint, not either speech model.

### xAI

xAI transcription exposes the single current model ID `grok-stt`. It posts multipart WAV audio to `/v1/audio/transcriptions` in 60-second overlapping batches and passes language and prompt. **Test** lists xAI models, so make a real transcription after it passes. xAI also has speech-generation utilities in the shared package, but mausVoice's current provider registry advertises this key for transcription, not as a post-processing model.

### AssemblyAI

AssemblyAI uses its dedicated v3 streaming WebSocket, with the API key in the connection query. It streams PCM16 audio, can emit committed segments for real-time output, and waits up to two seconds for finalization. Startup/finalization failure returns a warning and no transcript; there is no retained-audio fallback. The model-provider list is intentionally empty because the session does not expose a user model picker.

AssemblyAI's test lists transcripts from `/v2/transcript`; it can succeed without exercising the streaming endpoint. Stored-audio **Retranscribe** now has an AssemblyAI batch implementation: the repo uploads each 60-second segment to `/v2/upload`, creates a `/v2/transcript`, and polls until completion, with language detection when the language is auto.

## Generative providers

**DeepSeek** and **Cerebras** appear in post-processing and Assistant lists, not transcription. DeepSeek defaults to `deepseek-chat`, calls its OpenAI-compatible chat endpoint, and tests by listing models. Cerebras defaults to `zai-glm-4.7`, uses its chat-completions endpoint, and tests by listing models. Neither form currently includes a custom base URL or model picker; a saved explicit model, when present, overrides the default.

All hosted routes send task data off-device and remain subject to provider billing, retention, model access, limits, and policies. Test with short non-sensitive content before relying on a route, and never include an API key in diagnostics.
