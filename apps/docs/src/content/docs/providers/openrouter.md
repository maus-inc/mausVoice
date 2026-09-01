---
title: "OpenRouter"
description: "Choose OpenRouter models, favorites, and per-key upstream routing for rewriting, Assistant requests, and speech-to-text transcription."
sidebar:
  order: 5
---

OpenRouter works for both generation and transcription in mausVoice. Add its API key under **Settings → Processing → AI post processing**, **Assistant mode**, or **Transcription** and select that record for the task.

<<<<<<< HEAD
Expand **Model** on the selected key to fetch OpenRouter's live model catalog. Search matches model names and IDs, and stars keep preferred entries at the top. A key with no customized favorites starts with `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. If no model is saved at request time, generation and the key test default to `openai/gpt-4o-mini`. For transcription, pick an OpenRouter-routed STT model such as `openai/whisper-1`.

## Speech-to-text

When the OpenRouter key is the selected transcription record, mausVoice POSTs multipart audio to `${OPENROUTER_BASE_URL}/audio/transcriptions` through the OpenAI-compatible SDK and reads the returned `text` field. The active dictation language is forwarded as a `language` form field; selecting **Auto** lets the upstream model detect it. The selected model is required; selecting OpenRouter transcription without a model emits a warning and falls back to `openai/whisper-1`.
=======
Expand **Model** on the selected key to fetch OpenRouter's live model catalog. Search matches model names and IDs, and stars keep preferred entries at the top. A key with no customized favorites starts with `openai/gpt-oss-120b` and `openai/gpt-oss-20b`. If no model is saved at request time, generation defaults to `openai/gpt-oss-20b`.
>>>>>>> origin/fix/superfix-review-findings

## Route to upstream providers

Expand **Advanced Routing** to set an ordered provider list, allow or forbid fallbacks, and allow or deny providers that may collect data. mausVoice saves this configuration on the API-key record and sends it with requests made through that record. An empty priority list delegates routing to OpenRouter; fallback and data collection stay allowed unless you change them.

Denying data collection narrows eligibility, but it is not a complete local-privacy guarantee: requests still pass through OpenRouter and an eligible upstream. Review both services' current policies. Disabling fallbacks improves determinism but can reduce availability.

**Test** authenticates by listing models instead of spending tokens on a fixed inference model. The live model and provider catalogs can load successfully while a later request fails because the selected model has no eligible upstream under your routing rules. Record the exact model ID, ordered provider slugs, fallback setting, and data-collection setting when troubleshooting.
