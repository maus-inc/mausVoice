---
title: "History, audio, and Incognito"
description: "Control future local persistence without assuming retroactive deletion."
sidebar:
  order: 4
---

Normal operation stores transcription rows and attempts to save their audio snapshots. Audio uses the `transcription-audio/` directory under the app data root; metadata and text live in `mausvoice.db` in the app config directory. Automatic cleanup retains managed audio for only the 20 newest transcription rows that have audio.

**Incognito mode** prevents new transcription history and audio snapshots from being saved, and prevents glossary terms from being learned from a correction. Learned terms are proper nouns copied out of dictated text, so they are suppressed on the same grounds as the transcript they came from; the confirmation toast reports that the dictionary was left alone rather than staying silent. A separate **Include incognito in stats** option decides whether words dictated in Incognito contribute to usage statistics. When enabled, mausVoice records a random event ID, local date, word count, and source label for an eligible incognito dictation. It stores no transcript or audio for that event. Ephemeral sessions, failed dictations, and transcriptions received from another device do not add usage statistics.

Daily usage is an aggregate: deleting a row after it has been metered or backfilled does not subtract its recorded words. Legacy rows are backfilled on demand, so only rows still present when their date is first viewed can be included. **Clear local data** removes the daily totals and event ledger along with saved history.

Enabling Incognito is prospective. Review and remove existing history separately; use **Clear local data** only when its broader deletion of preferences, dictionary entries, and transcriptions is intended. Model files and logs occupy their own directories and should not be assumed to disappear with one history action.

Incognito controls mausVoice persistence, not an external transcription/post-processing provider, the target application, clipboard history, backups, or operating-system diagnostics. Use Local transcription and post-processing Off when provider transmission is also a concern.
