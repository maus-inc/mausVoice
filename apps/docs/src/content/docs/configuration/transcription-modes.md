---
title: "Transcription modes"
description: "Choose local sidecar recognition or an API endpoint without confusing transcription and rewriting."
sidebar:
  order: 2
---

Open **Settings → Processing → AI transcription** and choose **Local** or **API**.

**Local** starts a bundled Rust transcription sidecar on `127.0.0.1` and keeps speech recognition on this computer using a downloaded model — either a whisper.cpp GGML model or an ONNX Parakeet/Canary model. It still needs network access while downloading a model from its origin. The app sends audio chunks to the loopback sidecar during recording, but the sidecar buffers them and runs inference only at finalization—Local does not supply interim text for real-time output.

**API** sends recorded audio to the selected key entry or endpoint. Hosted services use their own billing, retention, and data policies; a self-hosted compatible endpoint can stay on infrastructure you control. Provider behavior is not uniform: some sessions stream audio while recording, while others send retained audio in overlapping batches after release.

Transcription and **AI post processing** are independent. Local + API post-processing keeps audio recognition local but sends transcript/context to a generative service. API + post-processing Off sends audio to transcription but runs no generative rewrite. The selected transcription key—not merely the presence of a stored key—determines the API route.

The current provider registry has one important mismatch: Ollama can appear transcription-capable in the UI, but the transcription dispatcher has no Ollama implementation and can fall into an unrelated Groq fallback. Do not choose Ollama for transcription; use Local or a provider with an implemented route.
