---
title: "Desktop architecture"
description: "Trace dictation from native input through sessions, processing, SQLite persistence, and final delivery."
sidebar:
  order: 3
---

The React frontend owns product orchestration; Rust owns privileged desktop capability. Generated wrappers in `@maus-inc/desktop-native-apis` are the typed invoke boundary between them.

A normal dictation roughly follows this path:

```text
global key or pill event
  → DictationSideEffects / dictation strategy
  → native audio recorder + selected TranscriptionSession
  → local sidecar or hosted provider
  → replacement rules
  → optional generative post-processing/style
  → history/audio persistence (unless Incognito)
  → local insertion or remote delivery
  → Zustand state and pill/status updates
```

`apps/desktop/src/actions/` performs stateful operations. `strategies/dictation.strategy.ts` handles dictation processing choices, while `components/root/DictationSideEffects.tsx` connects global events, the recorder, session lifecycle, timers, and output. `sessions/` separates dedicated AssemblyAI, Azure, Deepgram, ElevenLabs, Gladia, and Local lifecycles from retained-audio batch transcription.

Repositories under `repos/` select storage, model-provider, transcription, and generation implementations. Provider HTTP/WebSocket details generally belong in `packages/voice-ai`; local sidecar process/lease management belongs under `sidecars/`. Zustand/Immer slices under `state/` are combined by `store/` and rendered by React components.

The Tauri backend exposes recording, keyboard, focus, insertion, clipboard, permissions, paths, encrypted keys, diagnostics, SQLite queries, native overlays, and remote-output transport. Whisper inference is deliberately outside the main process in CPU/GPU sidecars. Windows and GTK pills are separate processes; the macOS pill is embedded with channels.

Preserve these boundaries. A UI component should not hand-roll provider auth or SQL. Rust should expose a narrow native operation rather than deciding which AI provider or style wins. When a cross-boundary type changes, update Rust, generated bindings, TypeScript consumers, and failure handling together.
