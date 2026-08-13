---
title: "Build a local-first setup"
description: "Keep core dictation local while accounting for downloads, history, clipboard, Assistant, and remote output."
sidebar:
  order: 2
---

For ordinary dictation, choose **Settings → Processing → AI transcription → Local**, download and select a validated model, then set **AI post processing → Off**. Keep Assistant mode disabled and multi-device output disconnected. After the model download, that core audio-to-final-text path does not require a hosted AI provider.

“Local” still has boundaries:

- Model download contacts Hugging Face. The app's sidecar itself binds to `127.0.0.1` on an ephemeral port and receives buffered audio over local HTTP.
- A local transcription plus API rewrite sends transcript, style, and context to the selected generative provider.
- Assistant mode has its own provider selection and can call tools; disabling ordinary post-processing does not turn Assistant off.
- Ollama, Speaches, and compatible endpoints are client/server paths even on localhost. Their binding, authentication, logs, and TLS are outside mausVoice.
- Multi-device output transmits final text over authenticated but unencrypted TCP and must not be enabled on an untrusted network.

Stored keys do not send requests by themselves, but removing unused entries makes the setup easier to audit. Enable Incognito before sensitive dictation if you do not want new history or audio snapshots persisted. It does not erase old records. Paste insertion also places text on the system clipboard, where the OS and clipboard managers may retain it.

For stronger assurance, monitor outbound traffic during a representative dictation and audit every enabled stage rather than relying on the word “Local.”
