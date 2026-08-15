---
title: "Local model reference"
description: "Map local model IDs to labels, filenames, download origins, and aliases."
sidebar:
  order: 3
---

| ID                  | UI label                 | Runtime      | Filename / artifact                                                           | Approx. download |
| ------------------- | ------------------------ | ------------ | ----------------------------------------------------------------------------- | ---------------: |
| `parakeet-ctc-0.6b` | NVIDIA Parakeet CTC 0.6B | ONNX Runtime | `model_int8.onnx_data` (plus `model_int8.onnx`, `tokenizer.json`)             |           613 MB |
| `parakeet-tdt-0.6b` | NVIDIA Parakeet TDT 0.6B | ONNX Runtime | `encoder-model.int8.onnx` (plus `decoder_joint-model.int8.onnx`, `vocab.txt`) |           670 MB |
| `canary-1b`         | NVIDIA Canary 1B         | ONNX Runtime | `encoder-model.int8.onnx` (plus `decoder-model.int8.onnx`, `vocab.txt`)       |          1.03 GB |
| `tiny`              | Whisper Tiny             | whisper.cpp  | `ggml-tiny.bin`                                                               |            77 MB |
| `base`              | Whisper Base             | whisper.cpp  | `ggml-base.bin`                                                               |           148 MB |
| `small`             | Whisper Small            | whisper.cpp  | `ggml-small.bin`                                                              |           488 MB |
| `medium`            | Whisper Medium           | whisper.cpp  | `ggml-medium.bin`                                                             |          1.53 GB |
| `turbo`             | Whisper Large v3 Turbo   | whisper.cpp  | `ggml-large-v3-turbo.bin`                                                     |           1.6 GB |
| `large`             | Whisper Large v3         | whisper.cpp  | `ggml-large-v3.bin`                                                           |           3.1 GB |

Whisper files download from `ggerganov/whisper.cpp` on Hugging Face into the app-data `transcription-models/` directory. Parakeet and Canary download into per-model subdirectories there; each may include an encoder plus companion tokenizer/config artifacts. The NVIDIA checkpoints are quantized INT8 ONNX builds. The upstream `Oriserve/Whisper-Hindi2Hinglish-Apex` checkpoint is not included because it publishes Transformers BF16 `model.safetensors`, which the sidecar cannot load. Development builds can override each supported URL with `RUST_TRANSCRIPTION_MODEL_URL_<UPPERCASE_ID>`.

Desktop normalization accepts older `.en` names for Tiny through Medium, `large-v3`, and several Large v3 Turbo spellings. Unknown saved values normalize to Tiny. Device IDs normalize to `cpu`, `cpu:<index>`, `gpu`, or `gpu:<index>`; legacy hyphenated IDs are converted, and an unrecognized value falls back to CPU.

The sidecar resamples finite input samples to 16 kHz and runs greedy decoding. Whisper models accept an explicit language and initial dictionary prompt and do not translate; Parakeet/Canary use their own ONNX inference path. Model validation loads the artifact through the selected runtime, so "Downloaded" is stronger than a filename-exists check.
