---
title: "Start here"
description: "Install mausVoice, finish first-run setup, and understand what happens to a dictation."
sidebar:
  order: 1
---

mausVoice is a desktop dictation app for macOS, Windows, and Linux. Hold a global shortcut, speak, and release; mausVoice transcribes the recording and inserts the result into the application that had focus. An optional second step can rewrite the raw transcript into a selected writing style.

## The shortest path to a first dictation

1. Download an installer from the [GitHub Releases page](https://github.com/maus-inc/mausVoice/releases) and follow the guide for your operating system.
2. Complete onboarding. In particular, allow microphone access and any input or accessibility permission requested by your platform.
3. Configure transcription. Choose **Local** and download a model, or choose **API** and select a configured transcription key.
4. Place the caret in a text field in another application.
5. Hold the dictation shortcut, speak, then release it. The default shortcut is **Fn** on macOS and **Left Meta + Left Control** on Windows. Your configured shortcut is shown under **Settings → General → Hotkey shortcuts**.

The recording pill is a status indicator, not the destination for text. Keep the target application focused when a recording ends so insertion goes to the intended field.

## Two independent processing decisions

**Transcription** turns audio into raw text. Local mode runs the bundled Rust/Whisper sidecar on your computer. API mode sends audio to the provider attached to the selected key.

**Post-processing** is optional and happens after transcription. When enabled, it sends transcript text—not a promise of local-only processing—to the selected generative provider and applies the active style. Set **Settings → Processing → AI post processing** to **Off** when raw output is preferable.

No account is required for the local and bring-your-own-key paths. Provider accounts, network access, retention, and charges depend on the external service you choose.
