---
title: "Incognito mode and audio retention"
description: "How Incognito affects saved history and audio, and how preserve-audio-on-failure protects failed transcriptions."
sidebar:
  order: 4.5
---

## What Incognito does

Incognito mode suppresses new transcription history and managed audio snapshots so dictated text does not appear in **History** and is not paired with an audio file. Enabling it is prospective: existing rows and snapshots stay until you remove them separately (per-row delete in **History**, or **Settings → Danger zone → Clear local data** for a broader reset).

Usage statistics have their own toggle, **Include incognito in stats**. With it on, words dictated in Incognito still count toward your personal totals; with it off, they do not. The two settings are independent.

Incognito only controls mausVoice's local persistence. It does not stop API processing at the provider, suppress target-app or clipboard retention, or clear operating-system diagnostics. Use local transcription and post-processing Off when the goal is also to avoid provider transmission.

## Audio retention on failed transcriptions

Incognito never writes the audio snapshot. The transcription result is also not added to your history. If the transcription later fails, the audio is gone too, so there is no on-disk recovery path for an Incognito recording. This is the privacy trade-off: Incognito guarantees that nothing about the recording is persisted locally, at the cost of being unable to recover a failed Incognito dictation.

The behavior at a glance:

- Incognito on, transcription succeeds: no audio on disk, no row in **History**.
- Incognito on, transcription fails: no audio on disk, no row in **History**. The recording cannot be recovered.
- Incognito off, transcription succeeds: audio is saved and the row appears in **History**.
- Incognito off, transcription fails: depends on **Preserve audio on failure** (see below).

## Preserve audio on failure

**Settings → General → Privacy → Preserve audio on failure** controls whether the audio snapshot is kept when a non-Incognito transcription fails. The default is **on**:

- **On (default):** the audio is retained alongside the failed transcription row, so you can replay it and recover the words.
- **Off:** the audio is dropped for failed transcriptions. Successful transcriptions still keep their audio. This is the older behavior and is useful when disk space matters more than recovery.

The setting applies only outside Incognito. In Incognito, the audio snapshot is never written to disk and the transcription is not added to your history, regardless of the result.
