---
title: Introduction to mausVoice
description: Understand the desktop dictation pipeline, its processing choices, and the safest way to adopt it.
sidebar:
  order: 1
---

mausVoice is a cross-platform desktop dictation application. A configurable global shortcut starts recording; the app converts speech to text, can optionally rewrite that text, stores a history entry when privacy settings allow it, and delivers the result to the editable field that has focus when output is inserted. The application detected at recording start can still determine app-specific style and insertion preferences.

That single gesture crosses several independent stages. Understanding them makes configuration, privacy review, and troubleshooting much simpler.

## The five-stage pipeline

1. **Capture:** the desktop app listens to the selected microphone while the shortcut is held. The native floating pill reports recording and processing state.
2. **Transcription:** audio is sent either to the bundled local Whisper sidecar or to the selected speech API. This stage decides which words were recognized.
3. **Text transformation:** glossary context, deterministic replacement rules, and optional AI post-processing can change the raw transcript. A Style changes writing; it does not improve the audio recording itself.
4. **Persistence:** unless Incognito or the related history settings suppress it, mausVoice writes history data to its local SQLite database and can retain a local audio snapshot.
5. **Delivery:** the app inserts the final text into the focused field through paste or simulated typing. It can instead send completed output to a configured receiver.

A failure at one stage does not prove the earlier stages failed. For example, a correct item in History with no text in the editor points to focus or insertion, not the microphone or provider.

## Local and API are task-specific choices

The **Local** and **API** choice under AI transcription applies to speech recognition. Local uses a model downloaded through mausVoice and served by the local Rust transcription process. API uses the provider or compatible endpoint selected for the transcription task.

The **AI post processing** setting is separate. **API** sends transcript text and relevant instructions to the selected generative provider; **Off** skips that network rewrite. Therefore, selecting Local transcription alone does not establish a completely local data flow. Review both task settings and any multi-device output before making that claim.

## A low-risk setup sequence

Use this order for a first installation:

1. Install the release for the operating system and complete its unsigned-build warning.
2. Grant microphone and input-control permissions required by that platform.
3. Select **Local** transcription and download a model, or configure one API transcription provider.
4. Leave AI post-processing **Off** for the first test.
5. Dictate one sentence into a plain text editor.
6. Confirm that the raw words appear correctly before enabling a Style, replacement rules, Assistant mode, or remote output.

This baseline creates a known-good path. Add one optional stage at a time and repeat the same test after each change.

## Accounts, keys, and data

The desktop application does not require a mausVoice subscription or account for its local and bring-your-own-key path. External services can require their own accounts, credentials, quotas, billing arrangements, and network access. Keys entered in the app are encrypted at rest, but encryption does not change what the selected provider receives during a request.

Never paste credentials into History, diagnostics, screenshots, documentation issues, or public bug reports. Follow the security-reporting page for vulnerabilities and use public GitHub Issues only for reports that have been scrubbed of sensitive data.

## Continue

Read the platform installation guide, then follow the onboarding walkthrough and first-dictation procedure. If mausVoice is already installed, the app tour maps the current navigation and the settings map shows where each processing choice lives.
