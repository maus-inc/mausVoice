---
title: "Terminology"
description: "Use precise product terms for capture, recognition, rewriting, history, delivery, Assistant, and native components."
sidebar:
  order: 8
---

- **Dictation:** one press/hold, speech capture, release, processing, and delivery operation.
- **Raw transcript:** text returned by the selected recognizer before deterministic replacement and optional generative rewriting.
- **Sanitized/processed transcript:** the later text retained for output/history; records can also retain raw text and prompts for inspection.
- **Post-processing:** optional generative rewriting after transcription. It is separate from recognition and requires a generative provider or supported local endpoint.
- **Style (tone):** an instruction that shapes post-processing format or voice. A style does nothing when generative processing is off.
- **Manual styling:** the user chooses/cycles an active style.
- **Application styling:** the focused app target can influence the selected style.
- **Glossary term:** vocabulary context supplied to compatible recognition paths; it is not guaranteed literal insertion.
- **Replacement rule:** deterministic raw-text substitution. A spoken trigger with a longer replacement can act as a snippet.
- **Assistant:** the tool-capable, conversational workflow launched by its own hold shortcut. It is not ordinary post-processing.
- **Chats:** persisted Assistant conversation history in the dashboard.
- **Pill:** the native floating recording/status overlay. macOS embeds its renderer; Windows/Linux use child processes.
- **Local mode:** bundled Rust recognition through the CPU/GPU sidecar using a downloaded model — either a whisper.cpp GGML model or an ONNX Parakeet/Canary model.
- **API mode:** recognition/generation through a configured hosted or self-hosted provider record.
- **Real-time output:** insertion of committed segments while a supported streaming Verbatim session remains active—not speculative interim text.
- **Remote output:** sending completed output to a paired device over the multi-device transport; distinct from provider networking.
- **Incognito:** suppression of newly persisted transcription history/audio. It is not a universal network-off or log-redaction guarantee.
- **App target:** a focused application identity with optional inherited/overridden style and insertion preferences.

Write the product name as **mausVoice**. In bug reports, name the failed stage—capture, transcription, replacement, post-processing, history, or delivery—instead of describing every output problem as “transcription.”
