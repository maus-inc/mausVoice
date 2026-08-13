---
title: "Troubleshooting checklist"
description: "Isolate shortcut, capture, transcription, post-processing, persistence, and insertion in order."
sidebar:
  order: 1
---

Treat dictation as a pipeline rather than one feature. Change one variable at a time.

1. **Shortcut:** does the pill react while another app is focused?
2. **Capture:** does the selected microphone produce a signal and work in another recorder?
3. **Raw transcription:** with post-processing Off, does text appear in History or on the clipboard?
4. **Rewrite:** after raw text works, does enabling post-processing fail with a particular provider?
5. **Insertion:** if clipboard/history is correct, does manual paste work in the target?
6. **Persistence:** is missing History explained by Incognito?

Reproduce in a plain text editor with a five-second sentence. Record the OS, release, installation type, Local/API mode, provider name, and exact non-secret error. On Linux include X11/Wayland and compositor.

Restart mausVoice after permission, microphone, or display changes. Do not clear local data first; it removes useful configuration and evidence without fixing external provider outages or operating-system permissions.
