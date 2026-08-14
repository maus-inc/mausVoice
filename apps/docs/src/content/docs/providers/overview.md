---
title: "Provider overview"
description: "Match the current provider forms and dispatch routes to transcription, post-processing, and Assistant tasks."
sidebar:
  order: 1
---

mausVoice filters credentials by task. “Available for transcription” means audio can be routed there; “available for generation” means the shared text-generation path can power post-processing and the API-backed Assistant. It does not mean every model from that company supports both.

| Provider label    |        Transcription        |     Generation      | Required connection fields                              |
| ----------------- | :-------------------------: | :-----------------: | ------------------------------------------------------- |
| Groq              |         Yes, batch          |         Yes         | API key                                                 |
| OpenAI            |         Yes, batch          |         Yes         | API key                                                 |
| Aldea             |         Yes, batch          |         No          | API key                                                 |
| AssemblyAI        | Yes, live session and batch |         No          | API key                                                 |
| ElevenLabs        | Yes, live session and batch |         No          | API key                                                 |
| Deepgram          |      Yes, live session      |         No          | API key                                                 |
| OpenRouter        |             No              |         Yes         | API key                                                 |
| Ollama            |             No              |         Yes         | Base URL; optional key                                  |
| OpenAI Compatible |         Yes, batch          |         Yes         | Base URL; optional key; `/v1` choice                    |
| Azure             | Yes, current bulk delivery  | Yes as Azure OpenAI | Speech region or OpenAI endpoint, plus the matching key |
| DeepSeek          |             No              |         Yes         | API key                                                 |
| Gemini            |         Yes, batch          |         Yes         | API key                                                 |
| Claude            |             No              |         Yes         | API key                                                 |
| Cerebras          |             No              |         Yes         | API key                                                 |
| Speaches          |         Yes, batch          |         No          | Base URL and transcription model                        |
| xAI Grok          |         Yes, batch          |         No          | API key                                                 |

“Live session” describes microphone transport during recording. Only AssemblyAI, Deepgram, and ElevenLabs currently emit committed segments into mausVoice's optional [real-time output](../../using-mausvoice/real-time-output/). Azure has a dedicated recognition session but currently returns its assembled transcript in bulk.

## Capability filter and dispatcher agreement

The capability filter and the transcription dispatcher agree: every provider surfaced for transcription has an implemented route. Ollama is generative-only because stock Ollama has no speech-to-text endpoint, so it is no longer offered under **AI transcription**. AssemblyAI covers both the live streaming session and stored-audio batch (upload → transcript → poll). A stale selection for a provider without a transcription route is treated as unselected and falls back to **Local** transcription with a warning instead of failing silently.

## Selection and tests

Each task stores its own mode, credential ID, and model field. Reusing one Groq, OpenAI, Gemini, or compatible credential does not couple those selections. Azure also changes its form and network API by task.

Integration tests are provider-specific smoke checks. Some list models; others submit a tiny generation, call an account endpoint, open a speech connection, or hit a health endpoint. A green result does not promise access to the chosen model, remaining quota, a supported language, real-time segments, or a particular provider privacy policy. Follow it with a short non-sensitive request in the actual task.

Choose **Local** instead of a provider record for bundled Whisper transcription. “Self-hosted” applies only to the endpoint you operate; review HTTP versus HTTPS, authentication, logs, and network exposure yourself.
