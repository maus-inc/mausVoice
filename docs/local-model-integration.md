# Local Model Integration Guide

Local speech recognition runs in **`packages/rust_transcription`**, a loopback HTTP sidecar (whisper.cpp GGML, ONNX Parakeet/Canary, SenseVoice via sherpa-onnx). The desktop leases the process from `apps/desktop/src/sidecars/`. Inference is **not** in-process `whisper-rs` and there is no `src-tauri/src/platform/whisper.rs`.

## Read these instead

- [Rust transcription sidecar](https://maus-inc.github.io/mausVoice/docs/development/transcription-sidecar/)
- [Local model management](https://maus-inc.github.io/mausVoice/docs/configuration/local-models/)
- [Local model reference](https://maus-inc.github.io/mausVoice/docs/reference/local-models/)
- `packages/rust_transcription/README.md`
- `packages/rust_transcription/src/models.rs` (enum, slugs, filenames, pinned URLs)

## Current flow

```
Settings (Local transcription + model/device)
        ↓
TypeScript sidecar client / LocalTranscribeAudioRepo
        ↓
Sidecar HTTP (download / session chunks / finalize)
        ↓
Whisper.cpp, ONNX Runtime, or sherpa-onnx
```

Models live under app-data `transcription-models/` (one-time migrate from old `models/`). Desktop-managed sidecars bind **127.0.0.1** on ephemeral ports. Session chunks are little-endian Float32. Each append decodes the uploaded
bytes into the session buffer; finalize runs inference on the buffered samples.
Idle sessions expire after ~10 minutes.

To add a model: extend `WhisperModel` in the sidecar, wire download/validate,
implement the runtime and transcription branches in `onnx_inference.rs` for any
new ONNX/sherpa model, then desktop Settings + types. Do not add a `cloud`
transcription mode — that path was removed.

Ollama remains a **generative** (cleanup/Assistant) provider, not a local STT engine.
