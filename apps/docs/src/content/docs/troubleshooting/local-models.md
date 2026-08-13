---
title: "Local model failures"
description: "Recover from download, validation, device, sidecar-session, and slow-inference failures."
sidebar:
  order: 6
---

Start in **Settings → Processing → AI transcription → Local**. A usable row must report **Downloaded** after validation; a file merely existing under app data is not enough.

## Download or validation fails

Use the row's **Delete** and **Download** actions rather than renaming files. Confirm Hugging Face is reachable, security software is not quarantining the sidecar or `.bin` file, and free space exceeds the displayed size. Downloads are polled for up to 45 minutes. An interrupted partial file should be replaced through the UI.

## No device appears

Device discovery always starts the CPU sidecar and asks it for devices. GPU discovery is attempted only for a detected discrete Vulkan GPU; an integrated GPU or a backend reported under another API will not satisfy that gate. Select `CPU • CPU` when available. A machine having a GPU does not guarantee compatibility with the bundled GPU binary.

## Recording succeeds but finalization fails

Local mode creates a loopback buffered session at recording start and queues audio chunks to it. If startup fails, the session disappears, a queued upload fails, or finalization errors, mausVoice attempts batch transcription from the retained recording and adds a warning. There is no hosted-provider fallback from Local mode. If retained audio is empty or has an invalid sample rate, the fallback cannot produce text.

## Inference is slow or memory-heavy

Turn post-processing Off, use the same short recording, select CPU explicitly, and compare Tiny/Base with the failing model. Local transcription does not decode continuously during recording; the visible wait normally happens after release. Export diagnostics and include the model ID, exact processing-device label, audio duration, validation text, and warning from History.
