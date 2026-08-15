---
title: "Local model management"
description: "Download, validate, select, and remove the GGML models used by the local sidecar."
sidebar:
  order: 3
---

Choose **Settings → Processing → AI transcription → Local**. Opening this panel starts the relevant loopback sidecar, discovers devices, and validates each model file. Every model remains listed; use its **Download** button before selecting it. Progress includes percentage and bytes when the server supplies a total.

| UI label               | ID       | Displayed download |
| ---------------------- | -------- | -----------------: |
| Whisper Tiny           | `tiny`   |              77 MB |
| Whisper Base           | `base`   |             148 MB |
| Whisper Small          | `small`  |             488 MB |
| Whisper Medium         | `medium` |            1.53 GB |
| Whisper Large v3 Turbo | `turbo`  |             1.6 GB |
| Whisper Large v3       | `large`  |             3.1 GB |

The six supported files come from the `ggerganov/whisper.cpp` Hugging Face repository. The public Hindi2Hinglish Apex checkpoint is published by Oriserve at `Oriserve/Whisper-Hindi2Hinglish-Apex`, but it is a Transformers BF16 `model.safetensors` checkpoint rather than a whisper.cpp GGML `.bin` file. It is therefore not offered in Local mode until a compatible converted artifact is published. Supported files are saved in the app-data directory's `transcription-models/` child and are shared by the CPU and GPU sidecars.

A model is selectable only when status says both downloaded and valid. Validation loads the model through whisper.cpp, so a corrupt or incompatible file is not treated as ready. The runtime also attempts to download an active missing model automatically, but doing that at dictation start can create a long, poorly timed wait; download and verify it in Settings first.

**Delete** removes the shared model file. If it was selected, the UI chooses the first remaining valid model in displayed order. If none remains, download one before the next dictation. Keep more free space than the displayed file size for partial download and filesystem overhead.
