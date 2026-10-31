---
title: "Clear local data"
description: "Understand the destructive reset before typing the confirmation word."
sidebar:
  order: 12
---

Open **Settings → Account → Danger zone → Clear local data**. The confirmation dialog lists what will be removed, then requires typing `clear`; the action is irreversible, and the dialog says so.

The current command empties fourteen SQLite tables, including chat messages, conversations, profiles, transcriptions, terms, hotkeys, API keys, preferences, styles, app targets, paired devices, pending audio deletions, daily word totals, and their usage-event ledger. It deletes managed transcription audio and orphaned WAVs, clears the app-managed `storage/` directory, removes database quarantine backups and the previous-brand database copy, and attempts to vacuum the database. It also clears app-owned browser storage such as the profile photo, onboarding flags, pending transcription deletes, and per-tool approvals. Signed-in session keys remain because clearing local data does not sign out. If required cleanup fails, local writes stay blocked and the dialog offers a retry. Vacuum is best effort after deletion. Use this for a genuine local reset, not as the first response to a provider outage, permission problem, or one bad style.

Before confirming, copy any history text you need and note shortcuts, provider selections, writing styles, app-target settings, and other preferences that will need to be rebuilt. The reset clears the app-managed `storage/` directory and managed transcription audio as well as the listed database tables, but it does **not** delete the database file itself, downloaded models, or log files. Startup also writes an operational `bridge-server.json` containing only the loopback bridge port; it is regenerated on launch and is not user content. The reset does not undo operating-system integrations such as compositor hotkey bindings or the Java Access Bridge entry in `~/.accessibility.properties`; those are stored outside mausVoice's data directories. Inspect the documented data directories and relevant system settings separately if the goal is complete removal. This is application-level cleanup, not secure whole-disk erasure.

mausVoice stores API credentials locally in encrypted form, and this action clears their database rows, but account-side keys remain valid until you revoke them at the provider. Clearing local data is not key rotation. If a credential may be exposed, revoke it in the provider console even after resetting mausVoice.
