---
title: "Microphone problems"
description: "Diagnose missing devices, silence, wrong inputs, and degraded headset audio."
sidebar:
  order: 3
---

Open **Settings → General → Microphone** and choose the intended input. Disconnecting a dock, USB interface, or Bluetooth headset can leave a stale selection, so select again after hardware changes.

Confirm microphone access in the operating system and record a sample in another native app. A device can be listed even while its permission is denied. Quit and reopen mausVoice after granting access.

If recordings are quiet or distorted, disable audio loopback, move away from loud speakers, and compare a wired or built-in microphone. Bluetooth headsets can switch to a lower-bandwidth hands-free profile when capture starts. That is an audio-path issue, not evidence that a larger Whisper model is required.

When audio works elsewhere but mausVoice fails, include the device label, connection type, platform, and whether the onboarding microphone test shows activity. Never attach a private real-world recording when a synthetic test sentence reproduces the issue.
