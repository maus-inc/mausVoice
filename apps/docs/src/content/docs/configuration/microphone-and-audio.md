---
title: "Microphone and audio settings"
description: "Select an input device, control interaction sound, and understand system-playback dimming."
sidebar:
  order: 7
---

## Choose the capture device

Open **Settings → General → Microphone** and choose the device mausVoice should pass to the recorder. Device labels come from the operating system. If no explicit preference is stored, the recorder uses the current system default.

A disconnected USB or Bluetooth device can remain selected without producing useful samples. Reopen the dialog after docking, waking a headset, or changing the operating-system default. Microphone permission is independent of selection: a device can appear in the list even when the OS blocks capture.

For a controlled test, speak at a normal distance in a quiet room and avoid monitoring the same microphone through speakers. Some Bluetooth headsets switch to a lower-bandwidth hands-free profile as soon as capture begins; compare the built-in microphone before blaming the transcription model.

## Chime and playback dimming

Open **Settings → General → Audio** for two recording-time behaviors:

- **Interaction chime** plays feedback at recording start and stop. Disable it when recording system output or when the sound would be disruptive.
- **Dim audio while dictating** multiplies the current system playback volume by the selected percentage when recording begins and restores the saved pre-dictation value afterward. **100%** means no dimming; **0%** attempts to mute other playback. It does not change microphone gain or the captured waveform.

The app treats volume-control failure as nonfatal so dictation can continue. If playback is not restored after a crash or forced termination, set the system volume manually. Normal cancellation and completion both attempt restoration.

After granting a new operating-system permission or connecting a device that was absent at launch, restart mausVoice if the recorder still uses stale device information.
