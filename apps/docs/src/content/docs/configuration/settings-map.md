---
title: "Settings map"
description: "Locate every top-level configuration area in the current desktop app."
sidebar:
  order: 1
---

Open **Settings** from the bottom of the left navigation rail. The page uses sections and opens focused dialogs for settings that need more room.

## General

- **Start on system startup** toggles operating-system auto-launch.
- **Microphone** selects a capture device.
- **Audio** controls the start/stop interaction chime and system-playback dim level during recording.
- **Hotkey shortcuts** configures hold-to-dictate, cancel, open chat, add-to-dictionary, Assistant, and manual-style actions. Conditional actions appear only when their feature is active.
- **Diagnostics** shows platform paths and exports a support bundle.
- **Style hotkeys** assigns one optional global shortcut to each writing style.
- **Text insertion options** chooses paste or simulated typing globally and per detected application.
- **More settings** contains Incognito, update prompts, menu-bar visibility, dictation pill visibility, pill reset monitor, spoken commands, real-time output, review before insert, silence hallucination filter, switch style while dictating, streak celebrations, dictation limit, automatic style loading, styling mode, and multi-device output.

## Processing

- **Dictation language** chooses the primary recognition language; additional-language shortcuts are managed in the language dialog.
- **Deepgram API key** and **Groq API key** are quick credential forms for fast streaming transcription and generative post-processing respectively.
- **AI transcription** chooses Local or API processing, the local model/device, or a task-compatible provider record. Gladia records expose `solaria-1` and support live plus batch/import transcription.
- **AI post processing** chooses API or Off and a generative provider record.
- **Assistant mode** is the beta command/chat workflow, with a separate provider, shortcut, feature switch, and optional power mode.

A credential can appear in more than one task only when its provider supports that task. Selecting a transcription key does not automatically select it for post-processing or Assistant mode.

## Advanced, input setup, and danger zone

**Terms & conditions** opens the repository's AGPL license. **Input permissions** runs a platform-specific helper: uinput/udev setup on Linux, administrator-assisted input capture on Windows, and Accessibility plus Microphone requests on macOS. Windows also offers **Always run as administrator**, which takes effect on the next launch.

The **Danger zone** contains **Clear local data**. It clears eleven SQLite tables but is not a full uninstall or filesystem wipe; read the confirmation dialog and the [clear-local-data guide](../clear-local-data/) first.
