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

When a transcription fails (the provider rejects the request, returns an empty result, or returns warnings that mark the call as failed), the dictated words are lost unless the audio was already saved. To keep that recovery path open, mausVoice writes the audio snapshot **before** the Incognito check, so even an Incognito session has the audio on disk if the transcription later fails.

The behavior at a glance:

- Incognito on, transcription succeeds: audio is saved to disk, no row in **History** (Incognito still suppresses the record).
- Incognito on, transcription fails: audio is saved to disk, no row in **History**. The user can recover the audio file from the app's managed-audio directory.
- Incognito off, transcription succeeds: audio is saved and the row appears in **History**.
- Incognito off, transcription fails: depends on **Preserve audio on failure** (see below).

## Preserve audio on failure

**Settings → General → Privacy → Preserve audio on failure** controls whether the audio snapshot is kept when a non-Incognito transcription fails. The default is **on**:

- **On (default):** the audio is retained alongside the failed transcription row, so you can replay it and recover the words.
- **Off:** the audio is dropped for failed transcriptions. Successful transcriptions still keep their audio. This is the older behavior and is useful when disk space matters more than recovery.

The setting applies only outside Incognito. In Incognito, audio is always written to disk before the transcription result is known, because the recovery path is the main reason the audio exists in that mode.

A failed Incognito recording still produces no **History** row, even with the audio on disk. The audio is a recovery artifact, not a logged entry.
