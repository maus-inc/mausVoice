---
title: "Make your first dictation"
description: "Run a controlled end-to-end test from microphone to inserted text."
sidebar:
  order: 8
---

Use a plain text editor for the first test. It removes web-page shortcuts, rich-text behavior, terminal paste rules, and administrator-level boundaries from the equation.

## Test sequence

1. Open **Settings → General → Microphone** and select the intended device.
2. Open **Settings → Processing → AI transcription**. Choose **Local** with a downloaded model, or **API** with a tested transcription key.
3. For the clearest baseline, set **AI post processing** to **Off**. You can enable styles after raw transcription works.
4. Open TextEdit, Notepad, or a simple Linux editor. Click in a blank document until the caret is visible.
5. Hold the configured **Hold to dictate** shortcut. Say: "This is my first mausVoice test, with the number forty-two."
6. Release the shortcut and avoid changing focus until processing and insertion finish.

A successful test proves four separate stages: shortcut capture, audio recording, transcription, and insertion. History can help separate them. If a transcript appears in **History** but not in the editor, transcription worked and the fault is in target focus or insertion. If no history row is expected because Incognito is on, temporarily disable Incognito or inspect the live status instead.

Enable **AI post processing** only after this baseline works, then compare raw and processed output with a built-in style. This staged test prevents a provider error in the optional rewrite step from being mistaken for a microphone failure.
