---
title: "Local model reference"
description: "Map local model IDs to labels, GGML filenames, download origins, and aliases."
sidebar:
  order: 3
---

| ID               | UI label                    | GGML filename                       | Approx. download |
| ---------------- | --------------------------- | ----------------------------------- | ---------------: |
| `tiny`           | Whisper Tiny                | `ggml-tiny.bin`                     |            77 MB |
| `base`           | Whisper Base                | `ggml-base.bin`                     |           148 MB |
| `small`          | Whisper Small               | `ggml-small.bin`                    |           488 MB |
| `medium`         | Whisper Medium              | `ggml-medium.bin`                   |          1.53 GB |
| `turbo`          | Whisper Large v3 Turbo      | `ggml-large-v3-turbo.bin`           |           1.6 GB |
| `large`          | Whisper Large v3            | `ggml-large-v3.bin`                 |           3.1 GB |
| `hindi2hinglish` | Whisper Hindi2Hinglish Apex | `ggml-hindi2hinglish-apex-q5_1.bin` |           595 MB |

Standard files are downloaded from `ggerganov/whisper.cpp` on Hugging Face; the specialized file comes from `mausvoice/whisper-hindi2hinglish-apex-ggml`. Development builds can override each URL with `RUST_TRANSCRIPTION_MODEL_URL_<UPPERCASE_ID>`.

Desktop normalization accepts older `.en` names for Tiny through Medium, `large-v3`, several Large v3 Turbo spellings, and several Hindi2Hinglish aliases. Unknown saved values normalize to Tiny. Device IDs normalize to `cpu`, `cpu:<index>`, `gpu`, or `gpu:<index>`; legacy hyphenated IDs are converted, and an unrecognized value falls back to CPU.

The sidecar resamples finite input samples to 16 kHz, uses greedy decoding, does not translate, and can receive an explicit language and initial dictionary prompt. Its model validation loads the GGML context on the selected sidecar, so “Downloaded” is stronger than a filename-exists check.
