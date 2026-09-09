---
title: "OpenRouter"
description: "Choose OpenRouter models, favorites, and per-key upstream routing for rewriting, Assistant requests, and speech-to-text transcription."
sidebar:
  order: 5
---

OpenRouter works for both generation and transcription in mausVoice. Add its API key under **Settings → Processing → AI post processing**, **Assistant mode**, or **Transcription** and select that record for the task.

For post-processing, expand **Model** on the selected key to fetch OpenRouter's live text-model catalog. Search matches model names and IDs, and stars keep preferred entries at the top. A key with no customized favorites starts with `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. If no generation model is saved at request time, mausVoice uses `openai/gpt-oss-20b`.

## Speech-to-text

When the OpenRouter key is the selected transcription record, mausVoice POSTs multipart audio to `${OPENROUTER_BASE_URL}/audio/transcriptions` through the OpenAI-compatible SDK and reads the returned `text` field. The active dictation language is forwarded as a `language` form field; selecting **Auto** lets the upstream model detect it. Its transcription model picker asks OpenRouter for models with the `transcription` output modality, so it does not mix chat-only models into the list. Pick an STT model such as `openai/whisper-1`. If no model is saved, mausVoice adds a warning and uses `openai/whisper-large-v3`.

## Route to upstream providers

For post-processing and Assistant generation, expand **Advanced Routing** to set an ordered provider list, allow or forbid fallbacks, and allow or deny providers that may collect data. mausVoice saves this configuration on the API-key record and sends it with generation requests made through that record. An empty priority list delegates routing to OpenRouter; fallback and data collection stay allowed unless you change them.

OpenRouter's transcription endpoint does not apply this chat-routing configuration. Denying data collection for generation is not a complete local-privacy guarantee: requests still pass through OpenRouter and an eligible upstream. Review both services' current policies. Disabling generation fallbacks improves determinism but can reduce availability.

**Test** lists models through OpenRouter's account API. It checks the key, but does not exercise a generation model or speech-to-text. The live model and provider catalogs can load successfully while a later generation request fails because the selected model has no eligible upstream under your routing rules. Record the exact model ID, ordered provider slugs, fallback setting, and data-collection setting when troubleshooting.
