---
title: "Ollama"
description: "Use a local or remote Ollama server for generative tasks, with an important transcription limitation."
sidebar:
  order: 9
---

Ollama is implemented for post-processing and the API-backed Assistant. Start Ollama and pull the model outside mausVoice, then add an Ollama record in the relevant task dialog.

- **Base URL** defaults to `http://127.0.0.1:11434`.
- **API key** is optional and is sent as Bearer authentication when provided.
- The model picker checks the base URL and reads `/api/tags`; it does not download models.
- Generation uses Ollama's OpenAI-compatible API beneath `{base URL}/v1`.

Choose a model that appears in `ollama list`, or type its exact tag. Post-processing needs ordinary chat generation. Assistant use additionally depends on the model and Ollama version handling streaming, tool definitions, and tool-call responses correctly. A model working for cleanup may still fail in an Assistant conversation.

**Test** only checks whether a request to the base URL returns an HTTP success. It does not run the selected model. Verify with a short post-processing request before depending on it.

## Ollama is generative-only

Stock Ollama exposes no speech-to-text endpoint: its OpenAI-compatible surface covers chat, completions, models, embeddings, and responses, and whisper/STT support has not shipped upstream ([ollama/ollama#13475](https://github.com/ollama/ollama/pull/13475) was declined). mausVoice therefore no longer lists Ollama under **AI transcription** — the capability filter and the dispatcher agree. For local transcription, use **Local** bundled Whisper, Speaches, or an OpenAI-compatible speech endpoint. If a saved preference still points at an Ollama transcription record from an older build, mausVoice warns and routes the batch job to the Groq repository rather than failing silently; reselect the transcription key.

## Remote-server safety

The default loopback URL is local to this computer. If Ollama runs elsewhere, enter an address reachable from the desktop app, configure that server's network binding and firewall deliberately, and prefer HTTPS or a protected tunnel. Plain HTTP exposes transcripts, prompts, responses, and any configured token in transit. Provider-local does not mean process-sandboxed: the server and its model files remain outside mausVoice's security boundary.
