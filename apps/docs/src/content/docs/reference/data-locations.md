---
title: "Data locations"
description: "Identify the app-managed database, models, saved audio, general storage, logs, and profile boundaries."
sidebar:
  order: 6
---

mausVoice resolves platform folders through Tauri; it does not hard-code one cross-platform home path.

| Data                  | Resolved location                          | Notes                                                                                                                      |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| SQLite                | `mausvoice.db` in the app config directory | May have `mausvoice.db-wal` and `mausvoice.db-shm` companions                                                              |
| Local models          | `transcription-models/` under app data     | Managed whisper.cpp GGML and ONNX Parakeet/Canary downloads; files from the old `models/` directory are migrated here once |
| Saved dictation audio | `transcription-audio/` under app data      | Mono WAV snapshots linked from History                                                                                     |
| General files         | `storage/` under app data                  | App-managed storage repository                                                                                             |
| Logs                  | Tauri's app log directory                  | Rotated at 25 MB per file, up to 10 files kept (~250 MB cap)     |

The exact parent differs by OS, Tauri's application identifier, and build flavor. Production uses `com.mausinc.desktop`; local development uses `com.mausinc.desktop.local`, so a dev run deliberately has a separate profile. On upgrade, mausVoice moves files from the legacy app-data `models/` directory into `transcription-models/` before the sidecars start, without overwriting files already present. The Diagnostics export includes generated diagnostics information and files from the log directory, but not the SQLite database, models, or arbitrary app-data files.

The log directory uses `tauri-plugin-log` rotation: each file is capped at 25 MB and the most recent 10 files are retained, which keeps total log storage around 250 MB. Older rotated files are deleted automatically; the active file is the one matching the timestamp in its name. The default log level is `Info`; set `MAUSVOICE_LOG=debug` (or `trace`) in the environment to capture more detail when troubleshooting. The startup-diagnostics file (`startup_diagnostics.log`) lives in the same directory and is appended to on each launch.

Saved audio is bounded independently of text history: the purge command retains audio metadata/files for the newest 20 records with audio and clears older audio references. Incognito sessions do not create new history/audio snapshots. Deleting a transcription also manages its associated snapshot.

On upgrade, source contains a one-time migration from sibling `com.voquill.desktop/voquill.db` into the current config directory, including existing WAL/SHM companions. For a manual low-level backup, fully quit mausVoice and copy the database together with `-wal` and `-shm`; copying only the main file while SQLite is active can omit recent committed pages. API keys inside the database remain encrypted values, not plaintext, but the profile still deserves sensitive-data handling.
