---
title: "Local speech models"
description: "Choose between whisper.cpp and ONNX Runtime local models, manage downloads, and control them while they run."
sidebar:
  order: 3.5
---

mausVoice runs local transcription in a separate sidecar process. Two model families are supported:

| Family                   | Runtime            | Models                                              |
| ------------------------ | ------------------ | --------------------------------------------------- |
| Whisper                  | whisper.cpp (GGML) | Tiny, Base, Small, Medium, Large v3, Large v3 Turbo |
| NVIDIA Parakeet / Canary | ONNX Runtime       | Parakeet CTC 0.6B, Parakeet TDT 0.6B, Canary 1B     |

Whisper is the safe default across languages and hardware. The ONNX models are faster on modern CPUs: Parakeet CTC is tuned for low-latency English dictation, Parakeet TDT trades a little speed for better English accuracy, and Canary adds multilingual recognition with automatic punctuation and casing.

Open **Settings → Processing → AI transcription → Local** to see the full list. Each row shows the model, its size, and its download state.

## Downloads

A model is selectable only when it reports **Downloaded** after validation. A file merely existing on disk is not enough — the sidecar loads the artifact through its runtime (whisper.cpp for `.bin`, ONNX Runtime for `.onnx`) before marking it ready.

While a download is running the row exposes three controls:

- **Pause** — suspends the HTTP transfer but keeps the partial file. Use it when you need bandwidth back; the sidecar records a paused job across reconnects.
- **Resume** — continues from where the transfer stopped, when the origin supports range requests.
- **Cancel** — aborts the job and discards the partial artifact. Cancelled models start fresh on the next download.

Progress reports percentage, bytes downloaded, and total size when the server supplies one. The status badge reads `Downloading...`, `Paused`, or `Downloaded`. ONNX models may include companion files (tokenizers, configs) beyond the encoder; the sidecar groups them under one job and reports aggregate progress.

Downloads run on the sidecar, not in the main app, so a stalled or slow fetch does not block the UI or recording. Closing the app while a download is running stops the job; restart and choose **Download** again — already-validated files stay in place.

## Storage

All local models live under the app-data `transcription-models/` directory. Whisper files sit directly there; ONNX models occupy a subdirectory named after the model ID (for example `parakeet-tdt-0.6b/encoder-model.int8.onnx`). Upgrades from earlier versions move files out of the old `models/` directory automatically.

**Delete** removes the model file (or the ONNX model directory). If the deleted model was selected, the UI falls back to the first valid model in displayed order. Keep more free space than the displayed size for partial downloads and ONNX companion artifacts.

## Choosing a model

- For quick English dictation on a modern CPU, start with Parakeet CTC or Parakeet TDT.
- For multilingual work or less common languages, use Whisper — try Small with a GPU, or Medium/Large v3 if accuracy matters more than speed.
- For automatic punctuation and casing in several languages, try Canary 1B.
- On low-RAM machines, use the recommendation chip as a guide and test Base or Parakeet CTC before going larger. The advisory chip is not a benchmark; always validate with your own microphone and noise.

The active model can be changed at any time without restarting. The next dictation picks up the new selection.
