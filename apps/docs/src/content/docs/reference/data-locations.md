---
title: "Data locations"
description: "Identify the app-managed database, models, saved audio, general storage, logs, and profile boundaries."
sidebar:
  order: 6
---

mausVoice resolves platform folders through Tauri; it does not hard-code one cross-platform home path.

| Data                  | Resolved location                          | Notes                                                         |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| SQLite                | `mausvoice.db` in the app config directory | May have `mausvoice.db-wal` and `mausvoice.db-shm` companions |
| Local models          | `transcription-models/` under app data     | Managed GGML downloads shared by CPU/GPU sidecars             |
| Saved dictation audio | `transcription-audio/` under app data      | Mono WAV snapshots linked from History                        |
| General files         | `storage/` under app data                  | App-managed storage repository                                |
| Logs                  | Tauri's app log directory                  | Includes runtime and startup-diagnostics logs                 |

The exact parent differs by OS, Tauri's application identifier, and build flavor. Production uses `com.mausinc.desktop`; local development uses `com.mausinc.desktop.local`, so a dev run deliberately has a separate profile. On upgrade, files in the legacy app-data `models/` directory are moved into `transcription-models/` before the sidecars start, without overwriting files already present. The Diagnostics export includes generated diagnostics information and files from the log directory, but not the SQLite database, models, or arbitrary app-data files.

Saved audio is bounded independently of text history: the purge command retains audio metadata/files for the newest 20 records with audio and clears older audio references. Incognito sessions do not create new history/audio snapshots. Deleting a transcription also manages its associated snapshot.

On upgrade, source contains a one-time migration from sibling `com.voquill.desktop/voquill.db` into the current config directory, including existing WAL/SHM companions. For a manual low-level backup, fully quit mausVoice and copy the database together with `-wal` and `-shm`; copying only the main file while SQLite is active can omit recent committed pages. API keys inside the database remain encrypted values, not plaintext, but the profile still deserves sensitive-data handling.
