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

## Manual placement (advanced)

The Settings panel downloads every supported file and validates it before it is selectable. If the network blocks the built-in download, an air-gapped machine needs an offline archive, or a custom build must point at a private mirror, place the files directly under `transcription-models/` and restart the app. The runtime rescans the directory on launch and runs the same validation as a download, so a misplaced, truncated, or wrong-format file is not marked ready.

The parent directory is the Tauri app data directory. Production uses bundle id `com.mausinc.desktop`; local development uses `com.mausinc.desktop.local`, so dev and release do not share files.

| OS      | `transcription-models/` parent                                                  |
| ------- | ------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/com.mausinc.desktop/transcription-models/`      |
| Windows | `%APPDATA%\com.mausinc.desktop\transcription-models\` (resolve with `echo %APPDATA%`) |
| Linux   | `~/.local/share/com.mausinc.desktop/transcription-models/`                      |

Whisper files go straight into that directory. The filename must match the model ID exactly because the runtime opens it by name; a renamed file is treated as missing.

| UI label               | ID        | Expected filename              |
| ---------------------- | --------- | ------------------------------ |
| Whisper Tiny           | `tiny`    | `ggml-tiny.bin`                |
| Whisper Base           | `base`    | `ggml-base.bin`                |
| Whisper Small          | `small`   | `ggml-small.bin`               |
| Whisper Medium         | `medium`  | `ggml-medium.bin`              |
| Whisper Large v3       | `large`   | `ggml-large-v3.bin`            |
| Whisper Large v3 Turbo | `turbo`   | `ggml-large-v3-turbo.bin`      |

ONNX models (Parakeet CTC, Parakeet TDT, Canary 1B) ship multiple artifacts, so each gets its own subdirectory named after the model ID. The sidecar marks the model ready only after the encoder, decoder, tokenizer, and any companion files for that model are present together. Downloading from the Settings panel handles this grouping; manual placement must keep every artifact in the same subdirectory, or validation will keep failing.

Sources: the `ggerganov/whisper.cpp` Hugging Face repository for Whisper files, and the published NVIDIA ONNX checkpoints for Parakeet and Canary. The model id, expected filename, and required artifacts are defined in `packages/rust_transcription/src/models.rs`. After placing files, open **Settings → Processing → AI transcription → Local** and confirm the row's status reads both downloaded and valid before selecting it for the next dictation.
