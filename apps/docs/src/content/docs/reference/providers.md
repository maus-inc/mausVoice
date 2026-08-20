---
title: "Provider capability reference"
description: "Map current provider selectors, runtime dispatch, streaming sessions, local routes, and known capability mismatches."
sidebar:
  order: 4
---

The current API-key union contains Groq, OpenAI, Aldea, AssemblyAI, ElevenLabs, Deepgram, OpenRouter, Ollama, OpenAI-compatible, Azure, DeepSeek, Gemini, Claude, Cerebras, Speaches, and xAI.

| Task            | Providers surfaced by current capability code                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Transcription   | Groq, OpenAI, Aldea, AssemblyAI, ElevenLabs, Deepgram, OpenAI-compatible, Azure, Gemini, Speaches, xAI |
| Generative text | Groq, OpenAI, OpenRouter, Ollama, OpenAI-compatible, Azure OpenAI, DeepSeek, Gemini, Claude, Cerebras  |

Azure is always included and changes form semantics by task: Speech region/subscription key for transcription, endpoint/API key for generation. Local Whisper is selected as **Local**, not represented by an API-key row. Speaches is a self-hosted transcription route; Ollama is intended for local generative text.

Runtime session selection gives AssemblyAI, Azure Speech, Deepgram, and ElevenLabs dedicated streaming classes. Other API transcription choices use the buffered batch class; local mode has its own sidecar session. "Streaming" here means audio chunks can be sent before release; it does not promise visible live insertion for every style/provider combination.

The model-capability class and `getTranscribeAudioRepo()` now agree. Ollama intentionally reports no transcription capability and no longer appears in the transcription selector; mausVoice keeps Ollama's post-processing and Assistant use but does not expose speech-to-text through it, matching stock Ollama's lack of a transcription endpoint. AssemblyAI gained a real batch route (upload → transcript → poll) in the dispatcher. The dispatcher filters out a provider value without an implemented route before dispatch, treats it as unselected, and falls back to Local with a warning. Its catch-all Groq branch remains as defense-in-depth for any value that still reaches it, now with an explicit warning.

The same catch-all behavior means "Groq fallback" in code is implementation routing for an unhandled provider, not automatic service failover when another provider errors. Integration tests generally prove credentials/reachability, not account quota, model entitlement, regional availability, or full dictation. Use the dedicated provider guides for defaults, URL construction, and security boundaries.
