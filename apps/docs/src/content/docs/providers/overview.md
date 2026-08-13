---
title: "Provider overview"
description: "Match the current provider forms and dispatch routes to transcription, post-processing, and Assistant tasks."
sidebar:
  order: 1
---

mausVoice filters credentials by task. “Available for transcription” means audio can be routed there; “available for generation” means the shared text-generation path can power post-processing and the API-backed Assistant. It does not mean every model from that company supports both.

| Provider label    |       Transcription        |     Generation      | Required connection fields                              |
| ----------------- | :------------------------: | :-----------------: | ------------------------------------------------------- |
| Groq              |         Yes, batch         |         Yes         | API key                                                 |
| OpenAI            |         Yes, batch         |         Yes         | API key                                                 |
| Aldea             |         Yes, batch         |         No          | API key                                                 |
| AssemblyAI        |     Yes, live session      |         No          | API key                                                 |
| ElevenLabs        |     Yes, live session      |         No          | API key                                                 |
| Deepgram          |     Yes, live session      |         No          | API key                                                 |
| OpenRouter        |             No             |         Yes         | API key                                                 |
| Ollama            |      See caveat below      |         Yes         | Base URL; optional key                                  |
| OpenAI Compatible |         Yes, batch         |         Yes         | Base URL; optional key; `/v1` choice                    |
| Azure             | Yes, current bulk delivery | Yes as Azure OpenAI | Speech region or OpenAI endpoint, plus the matching key |
| DeepSeek          |             No             |         Yes         | API key                                                 |
| Gemini            |         Yes, batch         |         Yes         | API key                                                 |
| Claude            |             No             |         Yes         | API key                                                 |
| Cerebras          |             No             |         Yes         | API key                                                 |
| Speaches          |         Yes, batch         |         No          | Base URL and transcription model                        |
| xAI Grok          |         Yes, batch         |         No          | API key                                                 |

“Live session” describes microphone transport during recording. Only AssemblyAI, Deepgram, and ElevenLabs currently emit committed segments into mausVoice's optional [real-time output](../../using-mausvoice/real-time-output/). Azure has a dedicated recognition session but currently returns its assembled transcript in bulk.

## Current Ollama transcription caveat

The task filter currently exposes Ollama in **AI transcription** because its model-provider class reports transcription capability. The actual batch transcription dispatcher has no Ollama speech-to-text branch and falls through to the Groq repository. Do not select Ollama for transcription in this build. Ollama generation for post-processing and Assistant use is implemented.

## Selection and tests

Each task stores its own mode, credential ID, and model field. Reusing one Groq, OpenAI, Gemini, or compatible credential does not couple those selections. Azure also changes its form and network API by task.

Integration tests are provider-specific smoke checks. Some list models; others submit a tiny generation, call an account endpoint, open a speech connection, or hit a health endpoint. A green result does not promise access to the chosen model, remaining quota, a supported language, real-time segments, or a particular provider privacy policy. Follow it with a short non-sensitive request in the actual task.

Choose **Local** instead of a provider record for bundled Whisper transcription. “Self-hosted” applies only to the endpoint you operate; review HTTP versus HTTPS, authentication, logs, and network exposure yourself.
