---
title: "Choose a local model and device"
description: "Evaluate local accuracy, latency, memory, language behavior, and the app's advisory hardware ratings."
sidebar:
  order: 4
---

The best model is the smallest one that handles your real speech reliably. File size is not RAM use, inference speed, or a language-specific accuracy promise.

1. In **Settings → Processing → AI transcription → Local**, download Base or Small.
2. Choose an available **Processing device**. CPU is always attempted first for discovery; GPU choices appear only when the app detects a discrete Vulkan GPU and the shipped GPU sidecar starts successfully.
3. Turn **AI post processing** Off and dictate the same representative 30-second passage three times.
4. Compare Raw text in History. Include names, numbers, punctuation intent, pauses, and your normal noise level.
5. Increase model size only when the measured recognition gain justifies the additional storage and finalization delay.

The recommendation chip is advisory. It tiers models by detected RAM: under 4 GB favors Tiny, Base, and Parakeet CTC; 4-8 GB reaches Small, Parakeet TDT, and SenseVoice; 8-16 GB reaches Medium, Turbo, and Canary 1B; and 16 GB or more reaches Large. A detected discrete Vulkan GPU raises that tier by one. This is a coarse rule, not a benchmark or memory check, and a cautioned choice remains downloadable.

The Parakeet and Canary models are optimized NVIDIA ONNX checkpoints (Parakeet is especially fast for English; Canary adds multilingual recognition with automatic punctuation and casing). SenseVoice is a smaller sherpa-onnx multilingual model (Chinese, English, Japanese, Korean, Cantonese) without punctuation. The selected dictation language and dictionary entries are passed to local inference as a language and initial prompt, so test those settings together with the model.

If a preferred GPU sidecar cannot start or transport requests fail, the manager marks it unavailable for the session and falls back to CPU. Not every inference error triggers that fallback; reproduce a failure on an explicitly selected CPU device before concluding the model itself is broken.
