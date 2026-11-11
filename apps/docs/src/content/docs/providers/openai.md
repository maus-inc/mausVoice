---
title: "OpenAI"
description: "Use an OpenAI key for batch transcription, transcript cleanup, and Assistant conversations."
sidebar:
  order: 5
---

Add OpenAI from **AI transcription**, **AI post processing**, or **Assistant mode** and provide an API key. The same saved record may be selected independently in all three dialogs.

## Transcription

OpenAI transcription is a batch path: mausVoice records the clip locally, creates an audio upload, and calls OpenAI after you release the shortcut. The default model ID is `whisper-1`; the offline fallback list also includes `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`. A specific dictation language is included; **Auto** omits that hint and lets the service infer it. This path does not provide committed segments to real-time output.

## Generation

Post-processing and the API-backed Assistant use OpenAI's chat-completion path. The cost-conscious default remains `gpt-4o-mini`. The model picker loads the account's live catalog and accepts new GPT and o-series IDs while filtering obvious non-chat families such as transcription, realtime, embeddings, moderation, TTS, and image models; that client-side filter is not a guarantee that every remaining model accepts the request shape.

Post-processing sends transcript text plus the active style instructions. Assistant requests can include conversation context and tool definitions. These are separate calls with separate task settings even when they share one key.

## What Test proves

**Test** lists models with the supplied credential. That checks basic authentication and API reachability, but does not submit audio or generation, confirm access to the selected model, detect exhausted quota, or validate language support.

Use a least-privilege project key where OpenAI account controls allow it, revoke it in the provider dashboard if exposed, and replace the local value. Deleting the local record does not revoke the provider-side credential or erase requests already handled by OpenAI.
