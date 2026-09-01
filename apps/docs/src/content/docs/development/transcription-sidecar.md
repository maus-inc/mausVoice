---
title: "Rust transcription sidecar"
description: "Build, run, test, and integrate the buffered CPU/GPU Whisper HTTP service."
sidebar:
  order: 6
---

`packages/rust_transcription` is a standalone Axum service (`whisper-rs`, `ort`, `tokio`). It builds `rust-transcription-cpu` and feature-gated `rust-transcription-gpu` (Metal on macOS, Vulkan on Linux/Windows). The desktop launches them on ephemeral loopback ports, although standalone defaults are `127.0.0.1:7771` for CPU and `:7772` for GPU (`RUST_TRANSCRIPTION_HOST` / `RUST_TRANSCRIPTION_PORT` / `RUST_TRANSCRIPTION_MODELS_DIR`).

```bash
cargo build --manifest-path packages/rust_transcription/Cargo.toml --release --bin rust-transcription-cpu
cargo build --manifest-path packages/rust_transcription/Cargo.toml --release --bin rust-transcription-gpu --features gpu,gpu-metal
# Linux/Windows GPU:
cargo build --manifest-path packages/rust_transcription/Cargo.toml --release --bin rust-transcription-gpu --features gpu,gpu-vulkan
```

Routes cover health, device enumeration, model download/job status/delete/validation, one-shot transcription, and create/chunk/finalize/delete session operations. Session chunks are raw little-endian Float32 bytes. "Streaming" here means chunked transport and in-memory buffering: inference runs at finalization, after finite samples are resampled to 16 kHz. Idle session buffers older than ten minutes are evicted.

Model IDs are the six whisper.cpp sizes (`tiny`, `base`, `small`, `medium`, `turbo`, `large`) plus the ONNX Runtime models `parakeet-ctc-0.6b`, `parakeet-tdt-0.6b`, and `canary-1b`, and sherpa-onnx **SenseVoice** (`sense-voice`). Whisper URLs default to the repositories recorded in `models.rs` and can be overridden with `RUST_TRANSCRIPTION_MODEL_URL_<ID>`. ONNX artifact URLs are pinned to immutable revisions and verified where upstream SHA-256 digests are available; they intentionally cannot be overridden at runtime. Host, port, and model directory also have environment overrides. Never bind the desktop-managed service to a public interface.

Run the binary-level integration suite with:

```bash
cargo test --manifest-path packages/rust_transcription/Cargo.toml \
  --test sidecar_integration -- --nocapture --test-threads=1
```

Add `--ignored` to run the full fixture transcription that downloads Tiny. Unit tests cover routing/session behavior separately. If the API changes, update the Rust README, desktop facade/client under `apps/desktop/src/sidecars/`, fallback behavior, and integration test together.
