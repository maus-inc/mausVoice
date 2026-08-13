---
title: "Real-time output"
description: "Stream committed dictation segments into the focused application with Verbatim and a supported provider."
sidebar:
  order: 16
---

Real-time output inserts completed speech segments while you are still recording instead of waiting to paste one final block. It is off by default. Enable it under **Settings → General → More settings → Real-time output**.

Three conditions must be true in the current implementation:

1. Set **Styling mode** to **Manual** under **Settings → General → More settings**.
2. Select the built-in **Verbatim** writing style.
3. Use an API transcription key for **AssemblyAI**, **Deepgram**, or **ElevenLabs**.

Those providers maintain live transcription sessions and report committed segments. Azure also has a dedicated live recognition session, but it deliberately reports no real-time-output support. Local transcription and the other API paths return a completed transcript in bulk. Assigning Verbatim to an app in **Based on app** mode does not currently activate segment insertion; select it in Manual mode.

## What happens to each segment

mausVoice waits for the provider to mark a segment as final or committed. Partial hypotheses are not pasted. It applies replacement rules and spoken-symbol conversion, adds a trailing space, and routes the result through the active output settings. It does not call the generative post-processing provider.

After at least one segment has been inserted, stopping the recording waits for the paste queue to finish and does not paste the provider's complete transcript a second time. The assembled streamed text is still used as the final transcription result. If the provider commits no segment during the recording, mausVoice falls back to its ordinary end-of-recording path.

## Use it safely

Keep the destination field focused for the entire recording. A segment goes to whichever target can receive input when that segment arrives, so changing windows can split one dictation across applications. Delivery errors are logged, but already inserted segments are not rolled back.

Cancellation also cannot retract text that has reached the destination. Remove it in the target application yourself. For an atomic all-at-once paste, or when exact review matters before insertion, turn real-time output off.

Test first in a plain text editor. If text arrives only after release, check all three prerequisites above and confirm the selected provider credential is the transcription key actually in use. If some committed segments are missing, inspect the clipboard, target permissions, insertion method, and diagnostic logs before changing recognition models.
