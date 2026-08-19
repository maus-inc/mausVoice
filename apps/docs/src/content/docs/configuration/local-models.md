---
title: "Local model management"
description: "Download, validate, select, and remove the local speech models used by the transcription sidecar."
sidebar:
  order: 3
---

Choose **Settings → Processing → AI transcription → Local**. Opening this panel starts the relevant loopback sidecar, discovers devices, and validates each model file. Every model remains listed; use its **Download** button before selecting it. Progress includes percentage and bytes when the server supplies a total.

| UI label                 | ID                  | Displayed download |
| ------------------------ | ------------------- | -----------------: |
| NVIDIA Parakeet CTC 0.6B | `parakeet-ctc-0.6b` |             613 MB |
| NVIDIA Parakeet TDT 0.6B | `parakeet-tdt-0.6b` |             670 MB |
| NVIDIA Canary 1B         | `canary-1b`         |            1.03 GB |
| SenseVoice (Multilingual)| `sense-voice`       |             226 MB |
| Whisper Tiny             | `tiny`              |              77 MB |
| Whisper Base             | `base`              |             148 MB |
| Whisper Small            | `small`             |             488 MB |
| Whisper Medium           | `medium`            |            1.53 GB |
| Whisper Large v3 Turbo   | `turbo`             |             1.6 GB |
| Whisper Large v3         | `large`             |             3.1 GB |

See [Local speech models](./local-speech-models/) for a side-by-side of the Whisper and ONNX families and a walkthrough of pause, resume, and cancel during downloads.

The three NVIDIA models run through ONNX Runtime (Parakeet CTC/TDT 0.6B and Canary 1B). **SenseVoice** (`sense-voice`) is a sherpa-onnx multilingual INT8 bundle (`model.int8.onnx` + `tokens.txt`, ~226 MB). The six Whisper files run through whisper.cpp and come from the `ggerganov/whisper.cpp` Hugging Face repository. Each ONNX/sherpa model ships a primary graph plus companion files; the sidecar groups them under one download job and only marks the model ready once every artifact is present. Whisper files sit directly in `transcription-models/`, while ONNX artifacts live in per-model subdirectories. The public Hindi2Hinglish Apex checkpoint is a Transformers BF16 `model.safetensors`, not a whisper.cpp GGML `.bin`, so it is not offered in Local mode. All local model files are shared by the CPU and GPU sidecars, and upgrades migrate files from the previous app-data `models/` directory automatically.

A model is selectable only when its status says both downloaded and valid. Validation loads the model through its runtime (whisper.cpp for GGML, ONNX Runtime for Parakeet/Canary, sherpa-onnx for SenseVoice), so a corrupt or incompatible file is not treated as ready. The runtime also attempts to download an active missing model automatically, but doing that at dictation start can create a long, poorly timed wait; download and verify it in Settings first.

**Delete** removes the model file (or, for ONNX models, the model's artifact directory). If the deleted model was selected, the UI chooses the first remaining valid model in displayed order. If none remains, download one before the next dictation. Keep more free space than the displayed file size for partial downloads, ONNX companion artifacts, and filesystem overhead.
