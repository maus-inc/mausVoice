---
title: "Transcription modes"
description: "Choose local sidecar recognition or an API endpoint without confusing transcription and rewriting."
sidebar:
  order: 2
---

Open **Settings → Processing → AI transcription** and choose **Local** or **API**.

**Local** starts a bundled Rust/whisper.cpp sidecar on `127.0.0.1`, uses a downloaded GGML model, and keeps speech recognition on this computer. It still needs network access while downloading a model from Hugging Face. The app sends audio chunks to the loopback sidecar during recording, but the sidecar buffers them and runs inference only at finalization—Local does not supply interim text for real-time output.

**API** sends recorded audio to the selected key entry or endpoint. Hosted services use their own billing, retention, and data policies; a self-hosted compatible endpoint can stay on infrastructure you control. Provider behavior is not uniform: some sessions stream audio while recording, while others send retained audio in overlapping batches after release.

Transcription and **AI post processing** are independent. Local + API post-processing keeps audio recognition local but sends transcript/context to a generative service. API + post-processing Off sends audio to transcription but runs no generative rewrite. The selected transcription key—not merely the presence of a stored key—determines the API route.

The provider capability filter and the transcription dispatcher agree: every provider offered under **AI transcription** has a real speech-to-text route, and Ollama no longer appears there because stock Ollama exposes no audio transcription endpoint (it stays generative-only). AssemblyAI uses a batch upload/transcript flow for stored audio. A stale saved selection for a provider without a transcription route is treated as unselected and falls back to **Local** transcription with a warning; reselect a transcription-capable key.
