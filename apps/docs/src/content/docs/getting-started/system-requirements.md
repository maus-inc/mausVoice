---
title: "System requirements"
description: "Check the supported desktop targets and practical requirements before installing."
sidebar:
  order: 2
---

mausVoice is built as a Tauri desktop application and ships separate packages for macOS, Windows, and Linux. Use an artifact intended for your platform; installers are not interchangeable.

## Supported targets

- **macOS:** the application configuration sets macOS 13.3 as its minimum system version. Current releases build a universal macOS bundle for Apple Silicon and Intel.
- **Windows:** current releases produce a Windows installer and bundle the WebView2 bootstrapper. Global capture and text insertion may request elevated input access.
- **Linux:** releases provide Debian and AppImage packages. Desktop behavior varies more because global shortcuts, simulated input, and overlays depend on X11 or the active Wayland compositor.

All platforms need a working microphone or audio input device. API-backed transcription and post-processing need network access to their configured endpoints. Local transcription can run without a provider connection after its model has been downloaded.

## Storage and compute

Reserve space for the app plus any local models. The selectable model downloads range from **77 MB** for Whisper Tiny to **3.1 GB** for Whisper Large v3; temporary download and installation overhead means free space should exceed the displayed model size. Larger models generally demand more memory and take longer on modest hardware.

GPU availability is discovered by the local sidecar. Do not assume the presence of a GPU guarantees acceleration: the supported execution device must appear in the local model configuration. CPU remains the portable fallback.

## Before troubleshooting

Use the latest release artifact, not a source archive. Confirm that the microphone works in another native application, and identify whether the session is X11 or Wayland on Linux with `echo $XDG_SESSION_TYPE`. Those details narrow most first-run failures quickly.
